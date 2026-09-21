/*
 * =========================================================================================
 * PROJETO: Central Agroclimática — Câmara de Fermentação com ESP32-C3 Super Mini
 * HARDWARE:
 *  - ESP32-C3 Super Mini
 *  - Sensor DHT22: Pino GPIO 0
 *  - Módulo Relé 1 (Lâmpada 220V - Aquecimento): Pino GPIO 10 (Active-Low)
 *  - Módulo Relé 2 (Cooler 12V - Ventilação / Resfriamento): Pino GPIO 5 (Active-Low)
 *  - Módulo Relé 3 (Fita LED 12V - Fotoperíodo): Pino GPIO 6 (Active-Low)
 *  - Display LCD 20x4 I2C: SDA -> GPIO 8, SCL -> GPIO 9 (Endereço 0x27)
 * 
 * CONECTIVIDADE HÍBRIDA & MULTI-WIFI:
 *  1. Conecta automaticamente tanto no Wi-Fi "LABIQ" quanto no Hotspot 4G "POCO"
 *  2. Conexão direta com o Servidor Local (192.168.0.105:3001) quando estiver no LABIQ
 *  3. Conexão via Túnel HTTPS Cloudflare quando estiver fora de casa/universidade
 *  4. Telemetria periódica (a cada 3s) e execução de comandos remotos (on, off, auto)
 *  5. Suporte à Parada Geral de Emergência remota com travamento seguro
 *  6. Autonomia 100% offline: histerese e fotoperíodo continuam rodando localmente
 * =========================================================================================
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WebServer.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <DHT.h>
#include <time.h>
#include <ArduinoJson.h>

// =========================================================================================
// CONFIGURAÇÃO DO DISPLAY LCD 20x4 (I2C)
// =========================================================================================
#define LCD_ADDRESS    0x27
#define LCD_COLS         20
#define LCD_ROWS          4

// =========================================================================
// CONFIGURAÇÃO DA REDE WI-FI & SERVIDOR CENTRAL
// =========================================================================
const char* WIFI_SSID_1 = "LABIQ";
const char* WIFI_PASS_1 = "Jessuino@2201";

const char* WIFI_SSID_2 = "POCO";
const char* WIFI_PASS_2 = "leonardo";

// URLs do Servidor Central (Rede Local + Túnel Público HTTPS)
const char* SERVER_URL_LOCAL  = "http://192.168.0.105:3001";
const char* SERVER_URL_TUNNEL = "https://neo-distant-legislative-ocean.trycloudflare.com";

// Servidores NTP para Sincronização do Relógio de Brasília (UTC-3)
const char* NTP_SERVER1 = "a.st1.ntp.br";
const char* NTP_SERVER2 = "pool.ntp.br";
const char* NTP_SERVER3 = "time.google.com";

const long  GMT_OFFSET_SEC      = -3 * 3600;
const int   DAYLIGHT_OFFSET_SEC = 0;

// =========================================================================================
// DEFINIÇÃO DE PINOS — ESP32-C3 SUPER MINI
// =========================================================================================
#define PIN_DHT            0   // Sensor DHT22 no Pino GPIO 0
#define PIN_RELE_LAMPADA  10   // Relé 1: Lâmpada 220V (Aquecimento) - Pino GPIO 10
#define PIN_RELE_COOLER    5   // Relé 2: Cooler 12V (Ventilação / Resfriamento) - Pino GPIO 5
#define PIN_RELE_LED       6   // Relé 3: Fita LED 12V (Fotoperíodo) - Pino GPIO 6

// Barramento I2C para Display LCD (Pinos padrão Arduino do ESP32-C3)
#define PIN_I2C_SDA        8   // Barramento I2C: SDA - Pino GPIO 8
#define PIN_I2C_SCL        9   // Barramento I2C: SCL - Pino GPIO 9

#define DHTTYPE        DHT22

// Níveis lógicos Active-High (LOW = Desligado, HIGH = Ligado)
#define RELAY_ON   HIGH
#define RELAY_OFF  LOW

// =========================================================================================
// PARÂMETROS DE CONTROLE TÉRMICO E FOTOPERÍODO
// =========================================================================================
const float TEMP_MIN = 26.0;   // Liga aquecedor / Desliga cooler
const float TEMP_MAX = 28.0;   // Desliga aquecedor / Liga cooler

const int HORA_LIGA_LED    = 5;   // 05:00 da manhã
const int HORA_DESLIGA_LED = 17;  // 17:00 da tarde (12h de luz)

// =========================================================================================
// OBJETOS E INSTÂNCIAS
// =========================================================================
LiquidCrystal_I2C lcd(LCD_ADDRESS, LCD_COLS, LCD_ROWS);
DHT dht(PIN_DHT, DHTTYPE);
WebServer server(80);

// =========================================================================================
// VARIÁVEIS DE ESTADO
// =========================================================================
bool modoAutoAquec      = true;
bool modoAutoCooler     = true;
bool modoAutoLed        = true;

bool aquecedorAtivo     = false;
bool coolerAtivo        = false;
bool ledAtivo           = false;

// Pós-Ventilação do Cooler (Dissipação térmica de 5 minutos após desligar o aquecedor)
const unsigned long TEMPO_POS_VENTILACAO_MS = 5UL * 60UL * 1000UL; // 300.000 ms (5 minutos)
unsigned long tempoDesligamentoAquecedor    = 0;
bool coolerEmPosVentilacao                  = false;

bool sistemaAtivoRemoto = true; // Flag de Parada Geral de Emergência

float temperatura       = 0.0;
float umidade           = 0.0;
bool erroDHT            = false;
bool ntpSincronizado    = false;

unsigned long ultimoTempoDHT        = 0;
unsigned long ultimoTempoDisplay    = 0;
unsigned long ultimoTempoWifiTent   = 0;
unsigned long ultimoTempoTelemetria = 0;

// Protótipos
void atualizarDisplay(const struct tm &agora, bool horaValida);
void recuperarLCD();
void enviarEventoRele(const char* rele, const char* estado, const char* modo, const char* motivo);
void enviarTelemetriaServidor();
void executarComandoRemoto(const char* rele, const char* action);
void aplicarParadaGeral(bool ativo);
int enviarHttpComFallback(const String &endpoint, const String &json, String &payloadOut);

// =========================================================================
// COMUNICAÇÃO HTTP INTELIGENTE (LOCAL OU TÚNEL HTTPS COM FALLBACK)
// =========================================================================
int enviarHttpComFallback(const String &endpoint, const String &json, String &payloadOut) {
  if (WiFi.status() != WL_CONNECTED) return -1;

  HTTPClient http;
  int httpCode = -1;

  // 1. Tenta primeiro conexão direta na rede local pelo IP do servidor
  String urlLocal = String(SERVER_URL_LOCAL) + endpoint;
  http.begin(urlLocal);
  http.setTimeout(1200); // Timeout rápido para não prender o loop
  http.addHeader("Content-Type", "application/json");
  httpCode = http.POST(json);
  if (httpCode > 0) {
    payloadOut = http.getString();
    http.end();
    Serial.printf("[HTTP LOCAL] Sucesso: %d\n", httpCode);
    return httpCode;
  }
  http.end();

  // 2. Se falhar ou estiver fora da rede local, usa o Túnel HTTPS Cloudflare
  WiFiClientSecure secureClient;
  secureClient.setInsecure(); // Conexão SSL leve sem certificados pesados
  String url = String(SERVER_URL_TUNNEL) + endpoint;
  http.begin(secureClient, url);
  http.setTimeout(3500);
  http.addHeader("Content-Type", "application/json");
  httpCode = http.POST(json);
  if (httpCode > 0) {
    payloadOut = http.getString();
    Serial.printf("[HTTP NUVEM] Sucesso: %d\n", httpCode);
  } else {
    Serial.printf("[HTTP NUVEM] Falha no tunel: %d\n", httpCode);
  }
  http.end();
  return httpCode;
}

// =========================================================================
// REGISTRO IMEDIATO DE EVENTO NO BANCO DE DADOS
// =========================================================================
void enviarEventoRele(const char* rele, const char* estado, const char* modo, const char* motivo) {
  String json = "{";
  json += "\"sistema\":\"regulador\",";
  json += "\"rele\":\"" + String(rele) + "\",";
  json += "\"estado\":\"" + String(estado) + "\",";
  json += "\"modo\":\"" + String(modo) + "\",";
  json += "\"motivo\":\"" + String(motivo) + "\",";
  json += "\"temperatura\":" + String(temperatura, 1) + ",";
  json += "\"umidade\":" + String(umidade, 1);
  json += "}";

  String dummy;
  enviarHttpComFallback("/api/evento-rele", json, dummy);
}

// =========================================================================
// EXECUTOR DE COMANDOS REMOTOS (INDIVIDUAIS POR RELÉ)
// =========================================================================
void executarComandoRemoto(const char* rele, const char* action) {
  if (!rele || !action) return;
  String r = String(rele);
  String act = String(action);
  r.toLowerCase();
  act.toLowerCase();

  Serial.printf("[COMANDO REGULADOR] Rele: %s | Acao: %s\n", r.c_str(), act.c_str());

  // Se o sistema estiver em parada geral e tentar ligar, bloqueia
  if (!sistemaAtivoRemoto && act == "on") {
    Serial.println(F("[SEGURANCA] Comando bloqueado: Sistema em Parada Geral!"));
    return;
  }

  // 1. AQUECEDOR (D10)
  if (r == "aquecedor" || r == "aquec") {
    if (act == "on") {
      modoAutoAquec = false;
      aquecedorAtivo = true;
      digitalWrite(PIN_RELE_LAMPADA, RELAY_ON);
      enviarEventoRele("aquecedor", "LIGADO", "MANUAL", "Comando manual via painel web");
    } else if (act == "off") {
      modoAutoAquec = false;
      aquecedorAtivo = false;
      digitalWrite(PIN_RELE_LAMPADA, RELAY_OFF);
      enviarEventoRele("aquecedor", "DESLIGADO", "MANUAL", "Comando manual via painel web");
    } else if (act == "auto") {
      modoAutoAquec = true;
      if (!erroDHT) {
        if (temperatura <= TEMP_MIN) aquecedorAtivo = true;
        else if (temperatura >= TEMP_MAX) aquecedorAtivo = false;
        digitalWrite(PIN_RELE_LAMPADA, aquecedorAtivo ? RELAY_ON : RELAY_OFF);
      }
      enviarEventoRele("aquecedor", aquecedorAtivo ? "LIGADO" : "DESLIGADO", "AUTOMATICO", "Restaurado modo automatico");
    }
    recuperarLCD();
  }
  // 2. COOLER / VENTILAÇÃO (D5)
  else if (r == "cooler" || r == "ventilador") {
    if (act == "on") {
      modoAutoCooler = false;
      coolerEmPosVentilacao = false;
      coolerAtivo = true;
      digitalWrite(PIN_RELE_COOLER, RELAY_ON);
      enviarEventoRele("cooler", "LIGADO", "MANUAL", "Comando manual via painel web");
    } else if (act == "off") {
      modoAutoCooler = false;
      coolerEmPosVentilacao = false;
      coolerAtivo = false;
      digitalWrite(PIN_RELE_COOLER, RELAY_OFF);
      enviarEventoRele("cooler", "DESLIGADO", "MANUAL", "Comando manual via painel web");
    } else if (act == "auto") {
      modoAutoCooler = true;
      if (aquecedorAtivo) {
        coolerAtivo = true;
      } else if (coolerEmPosVentilacao && (millis() - tempoDesligamentoAquecedor < TEMPO_POS_VENTILACAO_MS)) {
        coolerAtivo = true;
      } else {
        coolerAtivo = false;
      }
      digitalWrite(PIN_RELE_COOLER, coolerAtivo ? RELAY_ON : RELAY_OFF);
      enviarEventoRele("cooler", coolerAtivo ? "LIGADO" : "DESLIGADO", "AUTOMATICO", "Restaurado modo automatico");
    }
    recuperarLCD();
  }
  // 3. FITA LED / FOTOPERÍODO (D6)
  else if (r == "led" || r == "fotoperiodo") {
    if (act == "on") {
      modoAutoLed = false;
      ledAtivo = true;
      digitalWrite(PIN_RELE_LED, RELAY_ON);
      enviarEventoRele("led", "LIGADO", "MANUAL", "Comando manual via painel web");
    } else if (act == "off") {
      modoAutoLed = false;
      ledAtivo = false;
      digitalWrite(PIN_RELE_LED, RELAY_OFF);
      enviarEventoRele("led", "DESLIGADO", "MANUAL", "Comando manual via painel web");
    } else if (act == "auto") {
      modoAutoLed = true;
      struct tm agora;
      if (getLocalTime(&agora, 50)) {
        ledAtivo = (agora.tm_hour >= HORA_LIGA_LED && agora.tm_hour < HORA_DESLIGA_LED);
        digitalWrite(PIN_RELE_LED, ledAtivo ? RELAY_ON : RELAY_OFF);
      }
      enviarEventoRele("led", ledAtivo ? "LIGADO" : "DESLIGADO", "AUTOMATICO", "Restaurado modo automatico");
    }
    recuperarLCD();
  }
}

// =========================================================================
// GERENCIADOR DA PARADA GERAL DE EMERGÊNCIA
// =========================================================================
void aplicarParadaGeral(bool ativo) {
  if (sistemaAtivoRemoto != ativo) {
    sistemaAtivoRemoto = ativo;
    if (!sistemaAtivoRemoto) {
      modoAutoAquec = false;
      modoAutoCooler = false;
      modoAutoLed = false;
      aquecedorAtivo = false;
      coolerAtivo = false;
      coolerEmPosVentilacao = false;
      ledAtivo = false;
      digitalWrite(PIN_RELE_LAMPADA, RELAY_OFF);
      digitalWrite(PIN_RELE_COOLER, RELAY_OFF);
      digitalWrite(PIN_RELE_LED, RELAY_OFF);
      Serial.println(F("[PARADA GERAL] Regulador desativado remotamente! Todos os reles desligados."));
      enviarEventoRele("aquecedor", "DESLIGADO", "MANUAL", "PARADA GERAL ATIVADA");
      enviarEventoRele("cooler", "DESLIGADO", "MANUAL", "PARADA GERAL ATIVADA");
      enviarEventoRele("led", "DESLIGADO", "MANUAL", "PARADA GERAL ATIVADA");
    } else {
      modoAutoAquec = true;
      modoAutoCooler = true;
      modoAutoLed = true;
      coolerEmPosVentilacao = false;
      Serial.println(F("[REATIVADO] Sistema Regulador reativado. Retornando ao modo automatico."));
      enviarEventoRele("aquecedor", "DESLIGADO", "AUTOMATICO", "SISTEMA REATIVADO");
      enviarEventoRele("cooler", "DESLIGADO", "AUTOMATICO", "SISTEMA REATIVADO");
      enviarEventoRele("led", "DESLIGADO", "AUTOMATICO", "SISTEMA REATIVADO");
    }
    recuperarLCD();
  }
}

// =========================================================================
// TRANSMISSÃO DE TELEMETRIA & RECEBIMENTO DE COMANDOS DO SERVIDOR
// =========================================================================
void enviarTelemetriaServidor() {
  String json = "{";
  json += "\"sistema\":\"regulador\",";
  json += "\"temperatura\":" + String(temperatura, 1) + ",";
  json += "\"umidade\":" + String(umidade, 1) + ",";
  json += "\"reles_estado\":{";
  json += "\"aquecedor\":" + String(aquecedorAtivo ? "true" : "false") + ",";
  json += "\"cooler\":" + String(coolerAtivo ? "true" : "false") + ",";
  json += "\"led\":" + String(ledAtivo ? "true" : "false");
  json += "},";
  json += "\"reles_modo\":{";
  json += "\"aquecedor\":\"" + String(modoAutoAquec ? "auto" : "manual") + "\",";
  json += "\"cooler\":\"" + String(modoAutoCooler ? "auto" : "manual") + "\",";
  json += "\"led\":\"" + String(modoAutoLed ? "auto" : "manual") + "\"";
  json += "},";
  json += "\"ip_local\":\"" + WiFi.localIP().toString() + "\",";
  json += "\"sinal_wifi\":" + String(WiFi.RSSI());
  json += "}";

  String payload;
  int httpCode = enviarHttpComFallback("/api/telemetria", json, payload);

  if (httpCode == 200) {
#if ARDUINOJSON_VERSION_MAJOR >= 7
    JsonDocument doc;
#else
    StaticJsonDocument<1024> doc;
#endif

    DeserializationError err = deserializeJson(doc, payload);
    if (!err) {
      // 1. Processa Parada Geral (sistema_ativo)
      if (doc.containsKey("sistema_ativo")) {
        bool ativo = doc["sistema_ativo"].as<bool>();
        aplicarParadaGeral(ativo);
      }

      // 2. Processa Fila de Comandos Remotos
      if (doc.containsKey("comandos")) {
        JsonArray arr = doc["comandos"].as<JsonArray>();
        for (JsonObject cmd : arr) {
          const char* r = cmd["rele"];
          const char* a = cmd["action"];
          executarComandoRemoto(r, a);
        }
      }
    }
  }
}

// =========================================================================
// ROTAS DO WEBSERVER LOCAL (PORTA 80) — PAINEL DE CONTROLE DIRETO PELO IP
// =========================================================================
const char PAGE_INDEX[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Camara de Fermentacao - Painel Local</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; text-align: center; margin: 0; padding: 15px; }
.card { background: #1e293b; border-radius: 12px; padding: 16px; margin: 12px auto; max-width: 420px; box-shadow: 0 4px 10px rgba(0,0,0,0.4); }
.val { font-size: 2.2rem; font-weight: 800; }
.temp { color: #f87171; }
.umi { color: #38bdf8; }
.btn { border: none; padding: 10px 14px; margin: 3px; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 0.9rem; }
.btn-on { background: #10b981; color: white; }
.btn-off { background: #ef4444; color: white; }
.btn-auto { background: #3b82f6; color: white; }
.badge { display: inline-block; padding: 4px 10px; border-radius: 6px; font-size: 0.8rem; font-weight: bold; }
.bg-on { background: #065f46; color: #34d399; }
.bg-off { background: #7f1d1d; color: #f87171; }
</style>
</head>
<body>
<h2>C&acirc;mara de Fermenta&ccedil;&atilde;o</h2>
<p style="color:#94a3b8; font-size:0.85rem;">Acesso Direto pela Rede Local (ESP32-C3)</p>

<div class="card">
  <div style="display:flex; justify-content:space-around;">
    <div><div class="val temp" id="temp">--.- &deg;C</div><div style="color:#94a3b8">Temperatura</div></div>
    <div><div class="val umi" id="hum">--.- %</div><div style="color:#94a3b8">Umidade</div></div>
  </div>
</div>

<div class="card">
  <h3>Aquecedor 220V (D10)</h3>
  <p>Estado: <span id="st-aq" class="badge">--</span></p>
  <button class="btn btn-on" onclick="cmd('aquecedor','on')">LIGAR</button>
  <button class="btn btn-off" onclick="cmd('aquecedor','off')">DESLIGAR</button>
  <button class="btn btn-auto" onclick="cmd('aquecedor','auto')">AUTO</button>
</div>

<div class="card">
  <h3>Cooler / Ventila&ccedil;&atilde;o (D5)</h3>
  <p>Estado: <span id="st-cl" class="badge">--</span></p>
  <button class="btn btn-on" onclick="cmd('cooler','on')">LIGAR</button>
  <button class="btn btn-off" onclick="cmd('cooler','off')">DESLIGAR</button>
  <button class="btn btn-auto" onclick="cmd('cooler','auto')">AUTO</button>
</div>

<div class="card">
  <h3>Fita LED Fotoper&iacute;odo (D6)</h3>
  <p>Estado: <span id="st-ld" class="badge">--</span></p>
  <button class="btn btn-on" onclick="cmd('led','on')">LIGAR</button>
  <button class="btn btn-off" onclick="cmd('led','off')">DESLIGAR</button>
  <button class="btn btn-auto" onclick="cmd('led','auto')">AUTO</button>
</div>

<div class="card">
  <button class="btn btn-off" style="width:100%; padding:14px; font-size:1rem;" onclick="toggleEmerg()">PARADA GERAL DE EMERG&Ecirc;NCIA</button>
</div>

<script>
async function upd(){
  try {
    let r = await fetch('/api/status');
    let d = await r.json();
    document.getElementById('temp').innerHTML = d.temperatura + ' &deg;C';
    document.getElementById('hum').innerHTML = d.umidade + ' %';
    setBadge('st-aq', d.aquecedor);
    setBadge('st-cl', d.cooler);
    setBadge('st-ld', d.led);
  } catch(e){}
}
function setBadge(id, st){
  let el = document.getElementById(id);
  el.className = 'badge ' + (st ? 'bg-on' : 'bg-off');
  el.innerText = st ? 'LIGADO' : 'DESLIGADO';
}
async function cmd(rele, act){
  await fetch('/api/comando?rele='+rele+'&action='+act, {method:'POST'});
  setTimeout(upd, 300);
}
async function toggleEmerg(){
  if(confirm('Alterar Parada Geral?')){
    await fetch('/api/sistema/toggle', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({sistema_ativo: false})
    });
    setTimeout(upd, 300);
  }
}
setInterval(upd, 2000);
upd();
</script>
</body>
</html>
)rawliteral";

void handleRoot() {
  server.send(200, "text/html", PAGE_INDEX);
}

void handleStatus() {
  String json = "{";
  json += "\"sistema\":\"regulador\",";
  json += "\"temperatura\":" + String(temperatura, 1) + ",";
  json += "\"umidade\":" + String(umidade, 1) + ",";
  json += "\"aquecedor\":" + String(aquecedorAtivo ? "true" : "false") + ",";
  json += "\"cooler\":" + String(coolerAtivo ? "true" : "false") + ",";
  json += "\"led\":" + String(ledAtivo ? "true" : "false") + ",";
  json += "\"sistemaAtivo\":" + String(sistemaAtivoRemoto ? "true" : "false") + ",";
  json += "\"ip\":\"" + WiFi.localIP().toString() + "\"";
  json += "}";
  server.send(200, "application/json", json);
}

// Endpoint de Push Direto do Servidor para o ESP32 (Sub-segundo)
void handleApiComando() {
  String action = "";
  String rele = "";

  if (server.hasArg("plain")) {
    String body = server.arg("plain");
#if ARDUINOJSON_VERSION_MAJOR >= 7
    JsonDocument doc;
#else
    StaticJsonDocument<256> doc;
#endif
    if (!deserializeJson(doc, body)) {
      if (doc.containsKey("action")) action = doc["action"].as<String>();
      if (doc.containsKey("rele"))   rele = doc["rele"].as<String>();
    }
  } else {
    if (server.hasArg("action")) action = server.arg("action");
    if (server.hasArg("rele"))   rele = server.arg("rele");
  }

  if (action.length() > 0 && rele.length() > 0) {
    executarComandoRemoto(rele.c_str(), action.c_str());
    server.send(200, "application/json", "{\"status\":\"ok\",\"origem\":\"push_direto\"}");
  } else {
    server.send(400, "application/json", "{\"error\":\"parametros rele e action obrigatorios\"}");
  }
}

void handleApiToggle() {
  if (server.hasArg("plain")) {
    String body = server.arg("plain");
#if ARDUINOJSON_VERSION_MAJOR >= 7
    JsonDocument doc;
#else
    StaticJsonDocument<256> doc;
#endif
    if (!deserializeJson(doc, body)) {
      if (doc.containsKey("sistema_ativo")) {
        aplicarParadaGeral(doc["sistema_ativo"].as<bool>());
        server.send(200, "application/json", "{\"status\":\"ok\"}");
        return;
      }
    }
  }
  server.send(400, "application/json", "{\"error\":\"parametro sistema_ativo obrigatorio\"}");
}

// =========================================================================
// FUNÇÃO DE CONEXÃO WI-FI ROBUSTA (LABIQ & FALLBACK POCO)
// =========================================================================
void conectarWiFi() {
  Serial.println(F("\n[WIFI] Escaneando canais 2.4GHz para calibracao de RF..."));
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(150);

  // Escaneia brevemente com show_hidden=true para popular tabela interna de canais
  WiFi.scanNetworks(false, true);

  Serial.println(F("[WIFI] Conectando a rede LABIQ..."));
  WiFi.begin(WIFI_SSID_1, WIFI_PASS_1);
  int tentativas = 0;
  while (WiFi.status() != WL_CONNECTED && tentativas < 25) {
    delay(500);
    Serial.print(F("."));
    tentativas++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n-> Wi-Fi Conectado: %s | IP: %s | Sinal: %d dBm\n",
                  WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), WiFi.RSSI());
    return;
  }

  Serial.println(F("\n[WIFI] LABIQ nao disponivel. Tentando Hotspot POCO..."));
  WiFi.disconnect();
  delay(150);
  WiFi.begin(WIFI_SSID_2, WIFI_PASS_2);
  tentativas = 0;
  while (WiFi.status() != WL_CONNECTED && tentativas < 16) {
    delay(500);
    Serial.print(F("."));
    tentativas++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n-> Wi-Fi Conectado: %s | IP: %s | Sinal: %d dBm\n",
                  WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), WiFi.RSSI());
    return;
  }

  Serial.println(F("\n-> Nenhuma rede conectada. Modo offline autonomo ativado."));
}

// =========================================================================
// SETUP
// =========================================================================
void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println(F("\n======================================================="));
  Serial.println(F("Central Agroclimatica - Camara de Fermentacao (ESP32-C3)"));
  Serial.println(F("======================================================="));

  // 1. Configuração dos Pinos de Relé (Active-Low: Inicia Desligado)
  pinMode(PIN_RELE_LAMPADA, OUTPUT);
  pinMode(PIN_RELE_COOLER, OUTPUT);
  pinMode(PIN_RELE_LED, OUTPUT);

  digitalWrite(PIN_RELE_LAMPADA, RELAY_OFF);
  digitalWrite(PIN_RELE_COOLER, RELAY_OFF);
  digitalWrite(PIN_RELE_LED, RELAY_OFF);

  // 2. Inicialização do LCD 20x4
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  lcd.init();
  lcd.backlight();
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(F(" CENTRAL AGROCLIMA  "));
  lcd.setCursor(0, 1);
  lcd.print(F(" Cam. Fermentacao   "));
  lcd.setCursor(0, 2);
  lcd.print(F(" Conectando Wi-Fi..."));

  // 3. Inicialização do DHT22 no Pino GPIO 0
  dht.begin();

  // 4. Conexão Wi-Fi Direta (Compatível com Redes Ocultas)
  conectarWiFi();

  if (WiFi.status() == WL_CONNECTED) {
    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print(F(" WiFi Conectado!    "));
    lcd.setCursor(0, 1);
    char ipBuffer[21];
    snprintf(ipBuffer, sizeof(ipBuffer), "IP: %s", WiFi.localIP().toString().c_str());
    lcd.print(ipBuffer);
  } else {
    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print(F(" Modo Offline       "));
  }

  // 5. Configuração do NTP (Brasília UTC-3)
  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER1, NTP_SERVER2, NTP_SERVER3);

  // 6. Servidor Web Local para Push Direto
  server.on("/", handleRoot);
  server.on("/api/status", handleStatus);
  server.on("/dados", handleStatus);
  server.on("/api/comando", HTTP_POST, handleApiComando);
  server.on("/api/sistema/toggle", HTTP_POST, handleApiToggle);
  server.begin();

  Serial.println(F("Servidor Web HTTP local na porta 80 ativo."));
  delay(1200);
}

// =========================================================================
// LOOP PRINCIPAL
// =========================================================================
void loop() {
  server.handleClient();
  unsigned long tempoAtual = millis();

  // RECONEXÃO WI-FI NÃO-BLOQUEANTE (A cada 20 segundos)
  if (WiFi.status() != WL_CONNECTED && (tempoAtual - ultimoTempoWifiTent >= 20000)) {
    ultimoTempoWifiTent = tempoAtual;
    Serial.println(F("[WIFI] Tentando reconectar a rede LABIQ..."));
    WiFi.disconnect();
    delay(50);
    WiFi.begin(WIFI_SSID_1, WIFI_PASS_1);
  }

  // 1. LEITURA PERIÓDICA DO SENSOR DHT22 (A cada 2 segundos)
  if (tempoAtual - ultimoTempoDHT >= 2000) {
    ultimoTempoDHT = tempoAtual;
    float t = dht.readTemperature();
    float h = dht.readHumidity();

    if (!isnan(t) && !isnan(h)) {
      temperatura = t;
      umidade     = h;
      erroDHT     = false;
      Serial.printf("[DHT22 - GPIO 0] Temperatura: %.1f C | Umidade: %.1f %% | Aquec(D10): %s | Cooler(D5): %s | LED(D6): %s\n",
                    temperatura, umidade,
                    aquecedorAtivo ? "LIGADO" : "DESLIGADO",
                    coolerAtivo ? "LIGADO" : "DESLIGADO",
                    ledAtivo ? "LIGADO" : "DESLIGADO");

      // CONTROLE TÉRMICO AUTOMÁTICO POR HISTERESE
      if (sistemaAtivoRemoto) {
        // 1. Histerese do Aquecedor (Lâmpada D10)
        if (modoAutoAquec) {
          if (temperatura <= TEMP_MIN) {
            if (!aquecedorAtivo) {
              aquecedorAtivo = true;
              digitalWrite(PIN_RELE_LAMPADA, RELAY_ON);
              enviarEventoRele("aquecedor", "LIGADO", "AUTOMATICO", "Temperatura <= 26.0 C (Histerese Minima)");

              // Cooler liga simultaneamente com o aquecedor para circulação do ar quente
              if (modoAutoCooler) {
                coolerEmPosVentilacao = false;
                if (!coolerAtivo || digitalRead(PIN_RELE_COOLER) != RELAY_ON) {
                  coolerAtivo = true;
                  digitalWrite(PIN_RELE_COOLER, RELAY_ON);
                  enviarEventoRele("cooler", "LIGADO", "AUTOMATICO", "Ativacao simultanea com o aquecedor (Circulacao)");
                }
              }
            }
          } else if (temperatura >= TEMP_MAX) {
            if (aquecedorAtivo || digitalRead(PIN_RELE_LAMPADA) != RELAY_OFF) {
              aquecedorAtivo = false;
              digitalWrite(PIN_RELE_LAMPADA, RELAY_OFF);
              enviarEventoRele("aquecedor", "DESLIGADO", "AUTOMATICO", "Temperatura >= 28.0 C (Histerese Maxima)");

              // Inicia os 5 minutos de pós-ventilação do cooler para dissipar o calor residual
              if (modoAutoCooler) {
                coolerEmPosVentilacao = true;
                tempoDesligamentoAquecedor = millis();
                if (!coolerAtivo || digitalRead(PIN_RELE_COOLER) != RELAY_ON) {
                  coolerAtivo = true;
                  digitalWrite(PIN_RELE_COOLER, RELAY_ON);
                }
                enviarEventoRele("cooler", "LIGADO", "AUTOMATICO", "Inicio da pos-ventilacao de 5 min (Dissipacao)");
              }
            }
          }
        }

        // 2. Gerenciamento do Cooler / Ventilação (D5)
        if (modoAutoCooler) {
          if (aquecedorAtivo) {
            // Enquanto o aquecedor estiver ligado, o cooler deve permanecer ligado
            coolerEmPosVentilacao = false;
            if (!coolerAtivo || digitalRead(PIN_RELE_COOLER) != RELAY_ON) {
              coolerAtivo = true;
              digitalWrite(PIN_RELE_COOLER, RELAY_ON);
            }
          } else if (coolerEmPosVentilacao) {
            // Verifica se os 5 minutos de pós-ventilação já expiraram
            if (millis() - tempoDesligamentoAquecedor >= TEMPO_POS_VENTILACAO_MS) {
              coolerEmPosVentilacao = false;
              coolerAtivo = false;
              digitalWrite(PIN_RELE_COOLER, RELAY_OFF);
              enviarEventoRele("cooler", "DESLIGADO", "AUTOMATICO", "Fim da pos-ventilacao de 5 min (Cooler desligado)");
            } else {
              // Garante que o cooler permanece ligado durante os 5 minutos
              if (!coolerAtivo || digitalRead(PIN_RELE_COOLER) != RELAY_ON) {
                coolerAtivo = true;
                digitalWrite(PIN_RELE_COOLER, RELAY_ON);
              }
            }
          } else {
            // Aquecedor desligado e sem pós-ventilação ativa: cooler deve permanecer desligado
            if (coolerAtivo || digitalRead(PIN_RELE_COOLER) != RELAY_OFF) {
              coolerAtivo = false;
              digitalWrite(PIN_RELE_COOLER, RELAY_OFF);
            }
          }
        }

        // 3. Trava de Segurança Térmica Absoluta contra Superaquecimento (>= 30.0 °C)
        if (temperatura >= 30.0) {
          if (aquecedorAtivo || digitalRead(PIN_RELE_LAMPADA) != RELAY_OFF) {
            aquecedorAtivo = false;
            digitalWrite(PIN_RELE_LAMPADA, RELAY_OFF);
            Serial.println(F("[SEGURANCA TERMICA] Temp >= 30 C! Aquecedor forçado a DESLIGAR!"));
            enviarEventoRele("aquecedor", "DESLIGADO", "SEGURANCA", "Corte termico de protecao (>30C)");
          }
          if (!coolerAtivo || digitalRead(PIN_RELE_COOLER) != RELAY_ON) {
            coolerAtivo = true;
            digitalWrite(PIN_RELE_COOLER, RELAY_ON);
            Serial.println(F("[SEGURANCA TERMICA] Temp >= 30 C! Cooler ativado para resfriamento rapido!"));
            enviarEventoRele("cooler", "LIGADO", "SEGURANCA", "Resfriamento forcado de protecao (>30C)");
          }
        }
      }
    } else {
      erroDHT = true;
      Serial.println(F("[DHT22 - GPIO 0] Falha ao ler dados do sensor! Verifique se o pino DATA esta no GPIO 0."));
    }
  }

  // 2. ATUALIZAÇÃO DO DISPLAY LCD & FOTOPERÍODO (A cada 1 segundo)
  if (tempoAtual - ultimoTempoDisplay >= 1000) {
    ultimoTempoDisplay = tempoAtual;

    struct tm agora;
    bool horaValida = getLocalTime(&agora, 50);

    // CONTROLE AUTOMÁTICO DO FOTOPERÍODO (Fita LED D6: 05:00 às 17:00)
    if (horaValida && modoAutoLed && sistemaAtivoRemoto) {
      bool deveLigarLed = (agora.tm_hour >= HORA_LIGA_LED && agora.tm_hour < HORA_DESLIGA_LED);
      if (ledAtivo != deveLigarLed) {
        ledAtivo = deveLigarLed;
        digitalWrite(PIN_RELE_LED, ledAtivo ? RELAY_ON : RELAY_OFF);
        enviarEventoRele("led", ledAtivo ? "LIGADO" : "DESLIGADO", "AUTOMATICO",
          ledAtivo ? "Fotoperiodo 05:00h (Luz Ativada)" : "Fotoperiodo 17:00h (Luz Desativada)");
      }
    }

    atualizarDisplay(agora, horaValida);
  }

  // 3. TRANSMISSÃO DE TELEMETRIA E RECEBIMENTO DE COMANDOS (A cada 3 segundos)
  if (tempoAtual - ultimoTempoTelemetria >= 3000) {
    ultimoTempoTelemetria = tempoAtual;
    enviarTelemetriaServidor();
  }

  delay(10);
}

// =========================================================================
// ATUALIZAÇÃO DO DISPLAY LCD 20x4
// =========================================================================
void atualizarDisplay(const struct tm &agora, bool horaValida) {
  char buffer[21];

  // LINHA 0: Data/Hora ou Aviso de Parada Geral
  lcd.setCursor(0, 0);
  if (!sistemaAtivoRemoto) {
    lcd.print(F("! PARADA GERAL EMER !"));
  } else if (horaValida) {
    snprintf(buffer, sizeof(buffer), "%02d:%02d:%02d  %02d/%02d/%04d",
             agora.tm_hour, agora.tm_min, agora.tm_sec,
             agora.tm_mday, agora.tm_mon + 1, agora.tm_year + 1900);
    lcd.print(buffer);
  } else {
    lcd.print(F("--:--:-- Sinc NTP..."));
  }

  // LINHA 1: Temperatura e Umidade
  lcd.setCursor(0, 1);
  if (erroDHT) {
    lcd.print(F("ERRO LEITURA DHT22  "));
  } else {
    char strTemp[6];
    dtostrf(temperatura, 4, 1, strTemp);
    snprintf(buffer, sizeof(buffer), "T:%s\xDF""C   Umid:%2d%%  ", strTemp, (int)umidade);
    lcd.print(buffer);
  }

  // LINHA 2: Aquecedor (D10) e Cooler (D5)
  char linha2[21];
  snprintf(linha2, sizeof(linha2), "Aq:%s%s Cl:%s%s",
           aquecedorAtivo ? "ON " : "OFF", modoAutoAquec ? "[A]" : "[M]",
           coolerAtivo ? "ON " : "OFF", modoAutoCooler ? "[A]" : "[M]");
  lcd.setCursor(0, 2);
  lcd.print(linha2);

  // LINHA 3: Fotoperíodo (Fita LED D6) e IP
  char linha3[21];
  if (WiFi.status() == WL_CONNECTED) {
    snprintf(linha3, sizeof(linha3), "LED:%s%s IP:..%3d",
             ledAtivo ? "ON " : "OFF", modoAutoLed ? "[A]" : "[M]",
             WiFi.localIP()[3]);
  } else {
    snprintf(linha3, sizeof(linha3), "LED:%s%s Sem Wi-Fi",
             ledAtivo ? "ON " : "OFF", modoAutoLed ? "[A]" : "[M]");
  }
  lcd.setCursor(0, 3);
  lcd.print(linha3);
}

void recuperarLCD() {
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  lcd.init();
  lcd.backlight();
  struct tm agora;
  bool valida = getLocalTime(&agora, 20);
  atualizarDisplay(agora, valida);
}