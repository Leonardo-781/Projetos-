/*
 * =========================================================================================
 * PROJETO: Central Agroclimática — Estufa Inteligente com ESP32-C3 Super Mini
 * HARDWARE:
 *  - ESP32-C3 Super Mini
 *  - Sensor DHT22: Pino GPIO 3
 *  - Módulo Relé de Carga (Lâmpada/Aquecimento - Active-Low): Pino GPIO 4
 *  - Display LCD 16x2 I2C: SDA -> GPIO 6, SCL -> GPIO 7 (Endereço 0x27)
 * 
 * COMUNICAÇÃO BIDIRECIONAL COM O SERVIDOR:
 *  1. Telemetria periódica via HTTP POST para /api/telemetria (a cada 3s)
 *  2. Recebimento e execução imediata de comandos remotos (on, off, auto)
 *  3. Suporte a Parada Geral de Emergência remota com bloqueio de segurança
 *  4. Envio instantâneo de logs de evento para /api/evento-rele ao comutar
 *  5. Servidor Web local na porta 80 (/api/comando e /api/status para push direto)
 *  6. Autonomia 100% offline: opera normalmente se o Wi-Fi ou servidor oscilarem
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

// =========================================================================
// DEFINIÇÃO DE PINOS - ESP32-C3 SUPER MINI
// =========================================================================
const int pinoDHT   = 3; // DHT22 no pino GPIO 3
const int pinoRele  = 4; // Relé no pino GPIO 4 (Active-Low)

// Barramento I2C para Display LCD 16x2
const int pinoSDA   = 6; // GPIO 6 (SDA)
const int pinoSCL   = 7; // GPIO 7 (SCL)

// =========================================================================
// CONFIGURAÇÃO DE REDE & SERVIDOR CENTRAL
// =========================================================================
const char* WIFI_SSID_1 = "LABIQ";
const char* WIFI_PASS_1 = "Jessuino@2201";

const char* WIFI_SSID_2 = "POCO";
const char* WIFI_PASS_2 = "leonardo";

// URLs do Servidor Central (Rede Local + Túnel Público HTTPS)
const char* SERVER_URL_LOCAL  = "http://192.168.0.105:3001";
const char* SERVER_URL_TUNNEL = "https://server1.taila7d06b.ts.net:8443";

// Servidores NTP para Sincronização do Relógio de Brasília (UTC-3)
const long gmtOffset_sec     = -3 * 3600; 
const int  daylightOffset_sec = 0;
const char* ntpServer1       = "a.st1.ntp.br";
const char* ntpServer2       = "pool.ntp.org";
const char* ntpServer3       = "time.google.com";

// =========================================================================
// OBJETOS E INSTÂNCIAS
// =========================================================================
#define DHTTYPE DHT22
DHT dht(pinoDHT, DHTTYPE);

LiquidCrystal_I2C *lcd = nullptr;
uint8_t enderecoLCD    = 0x27;

WebServer server(80);

// Níveis lógicos para módulo relé Active-High (HIGH = Liga, LOW = Desliga)
const bool RELE_LIGADO    = HIGH;
const bool RELE_DESLIGADO = LOW;

// =========================================================================
// VARIÁVEIS DE ESTADO
// =========================================================================
bool modoAutomatico     = true;
bool estadoRele         = false;
bool sistemaAtivoRemoto = true; // Flag da Parada Geral de Emergência

float temperatura   = 0.0;
float umidade       = 0.0;
bool dhtOk          = false;
bool horaSincronizada = false;

// Programação Horária Automática: Ligar às 05:00 e Desligar às 17:00
const int HORA_LIGA      = 5;
const int MINUTO_LIGA    = 0;
const int HORA_DESLIGA   = 17;
const int MINUTO_DESLIGA = 0;

// Temporizadores não-bloqueantes
unsigned long ultimoTempoDHT        = 0;
unsigned long ultimoTempoLCD        = 0;
unsigned long ultimoTempoWifiTent   = 0;
unsigned long ultimoTempoTelemetria = 0;

// Protótipos de funções
void enviarEventoRele(const char* rele, const char* estado, const char* modo, const char* motivo);
void enviarTelemetriaServidor();
void executarComandoRemoto(const char* rele, const char* action);
void aplicarParadaGeral(bool ativo);
bool verificarHorarioAutomatico(int hora, int minuto);
String obterHoraFormatada();
void inicializarLCD();

// =========================================================================
// CONTROLE DO HARDWARE DO RELÉ
// =========================================================================
void acionarReleComMotivo(bool ligar, const char* motivo) {
  // Se estiver em Parada Geral, proíbe qualquer tentativa de ligar
  if (!sistemaAtivoRemoto && ligar) {
    Serial.println(F("[SEGURANCA] Acionamento bloqueado: Sistema em Parada Geral!"));
    return;
  }

  if (estadoRele != ligar) {
    estadoRele = ligar;
    digitalWrite(pinoRele, estadoRele ? RELE_LIGADO : RELE_DESLIGADO);
    Serial.printf("[RELE ESTUFA] -> %s | Motivo: %s\n", estadoRele ? "LIGADO" : "DESLIGADO", motivo);
    enviarEventoRele("rele_principal", estadoRele ? "LIGADO" : "DESLIGADO", modoAutomatico ? "AUTOMATICO" : "MANUAL", motivo);
  }
}

// =========================================================================
// EXECUTOR DE COMANDOS REMOTOS (VINDOS DO SERVIDOR OU PUSH DIRETO)
// =========================================================================
void executarComandoRemoto(const char* rele, const char* action) {
  if (!action) return;
  String act = String(action);
  act.toLowerCase();

  Serial.printf("[COMANDO RECEBIDO] Rele: %s | Acao: %s\n", rele ? rele : "principal", act.c_str());

  if (act == "on") {
    modoAutomatico = false;
    acionarReleComMotivo(true, "Comando manual via painel web");
  } else if (act == "off") {
    modoAutomatico = false;
    acionarReleComMotivo(false, "Comando manual via painel web");
  } else if (act == "auto") {
    modoAutomatico = true;
    struct tm timeinfo;
    if (getLocalTime(&timeinfo)) {
      bool deveLigar = verificarHorarioAutomatico(timeinfo.tm_hour, timeinfo.tm_min);
      acionarReleComMotivo(deveLigar, "Restaurado modo automatico");
    } else {
      enviarEventoRele("rele_principal", estadoRele ? "LIGADO" : "DESLIGADO", "AUTOMATICO", "Restaurado modo automatico");
    }
  }
}

// =========================================================================
// GERENCIADOR DA PARADA GERAL DE EMERGÊNCIA
// =========================================================================
void aplicarParadaGeral(bool ativo) {
  if (sistemaAtivoRemoto != ativo) {
    sistemaAtivoRemoto = ativo;
    if (!sistemaAtivoRemoto) {
      modoAutomatico = false;
      estadoRele = false;
      digitalWrite(pinoRele, RELE_DESLIGADO);
      Serial.println(F("[PARADA GERAL] Estufa desativada remotamente! Todos os reles desligados."));
      enviarEventoRele("rele_principal", "DESLIGADO", "MANUAL", "PARADA GERAL ATIVADA pelo operador");
    } else {
      modoAutomatico = true;
      Serial.println(F("[REATIVADO] Sistema da Estufa reativado com sucesso."));
      enviarEventoRele("rele_principal", "DESLIGADO", "AUTOMATICO", "SISTEMA REATIVADO pelo operador");
      struct tm timeinfo;
      if (getLocalTime(&timeinfo)) {
        bool deveLigar = verificarHorarioAutomatico(timeinfo.tm_hour, timeinfo.tm_min);
        acionarReleComMotivo(deveLigar, "Ciclo normal apos reativacao");
      }
    }
  }
}

// =========================================================================
// COMUNICAÇÃO HTTP INTELIGENTE (LOCAL OU TÚNEL HTTPS COM FALLBACK)
// =========================================================================
int enviarHttpComFallback(const String &endpoint, const String &json, String &payloadOut) {
  if (WiFi.status() != WL_CONNECTED) return -1;

  HTTPClient http;
  int httpCode = -1;

  // 1. Só tenta IP local se o próprio ESP estiver na mesma sub-rede do servidor em casa (192.168.0.x)
  IPAddress ip = WiFi.localIP();
  bool redeLocalServidor = (ip[0] == 192 && ip[1] == 168 && ip[2] == 0);

  if (redeLocalServidor) {
    String url = String(SERVER_URL_LOCAL) + endpoint;
    http.begin(url);
    http.setTimeout(800);
    http.addHeader("Content-Type", "application/json");
    httpCode = http.POST(json);
    if (httpCode > 0) {
      payloadOut = http.getString();
      http.end();
      Serial.printf("[HTTP LOCAL ESTUFA] Sucesso: %d\n", httpCode);
      return httpCode;
    }
    http.end();
  }

  // 2. Se estiver fora de casa (Universidade/LABIQ 10.x.x.x, 4G, etc.), usa direto o Túnel HTTPS sem perder 1.5s
  WiFiClientSecure secureClient;
  secureClient.setInsecure(); // Conexão SSL leve sem validação pesada
  String url = String(SERVER_URL_TUNNEL) + endpoint;
  http.begin(secureClient, url);
  http.setReuse(true); // Reutiliza sessão TLS para conexão ultrarrápida
  http.setTimeout(5000);
  http.addHeader("Content-Type", "application/json");
  httpCode = http.POST(json);
  if (httpCode > 0) {
    payloadOut = http.getString();
    Serial.printf("[HTTP NUVEM ESTUFA] Sucesso: %d\n", httpCode);
  } else {
    Serial.printf("[HTTP NUVEM ESTUFA] Falha no tunel: %d\n", httpCode);
  }
  http.end();
  return httpCode;
}

// =========================================================================
// REGISTRO IMEDIATO DE EVENTO NO BANCO DE DADOS
// =========================================================================
void enviarEventoRele(const char* rele, const char* estado, const char* modo, const char* motivo) {
  String json = "{";
  json += "\"sistema\":\"estufa\",";
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
// TRANSMISSÃO DE TELEMETRIA & RECEBIMENTO DE COMANDOS DO SERVIDOR
// =========================================================================
void enviarTelemetriaServidor() {
  String json = "{";
  json += "\"sistema\":\"estufa\",";
  json += "\"temperatura\":" + String(temperatura, 1) + ",";
  json += "\"umidade\":" + String(umidade, 1) + ",";
  json += "\"reles_estado\":{\"rele_principal\":" + String(estadoRele ? "true" : "false") + "},";
  json += "\"reles_modo\":{\"rele_principal\":\"" + String(modoAutomatico ? "auto" : "manual") + "\"},";
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
// CÁLCULO DA FAIXA HORÁRIA DO CICLO AUTOMÁTICO (17:00 às 05:00)
// =========================================================================
bool verificarHorarioAutomatico(int hora, int minuto) {
  int minutosAtuais = hora * 60 + minuto;
  int minutoLiga    = HORA_LIGA * 60 + MINUTO_LIGA;
  int minutoDesliga = HORA_DESLIGA * 60 + MINUTO_DESLIGA;

  if (minutoLiga < minutoDesliga) {
    return (minutosAtuais >= minutoLiga && minutosAtuais < minutoDesliga);
  } else {
    // Passa pela meia-noite
    return (minutosAtuais >= minutoLiga || minutosAtuais < minutoDesliga);
  }
}

// =========================================================================
// OBTÉM HORA FORMATADA
// =========================================================================
String obterHoraFormatada() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) return "--:--:--";
  char buffer[10];
  strftime(buffer, sizeof(buffer), "%H:%M:%S", &timeinfo);
  return String(buffer);
}

// =========================================================================
// INICIALIZAÇÃO DO DISPLAY LCD 16x2
// =========================================================================
void inicializarLCD() {
  Wire.begin(pinoSDA, pinoSCL);
  if (lcd != nullptr) delete lcd;
  lcd = new LiquidCrystal_I2C(enderecoLCD, 16, 2);
  lcd->init();
  lcd->backlight();
  lcd->clear();
}

// =========================================================================
// ROTAS DO SERVIDOR WEB LOCAL (PORTA 80)
// =========================================================================
void handleRoot() {
  server.send(200, "text/html", "<h2>Central Agroclimatica - Estufa Online</h2><p>Servidor: 192.168.0.105:3001</p>");
}

void handleStatus() {
  String json = "{";
  json += "\"sistema\":\"estufa\",";
  json += "\"temp\":" + String(temperatura, 1) + ",";
  json += "\"hum\":" + String(umidade, 1) + ",";
  json += "\"rele\":" + String(estadoRele ? "true" : "false") + ",";
  json += "\"modoAuto\":" + String(modoAutomatico ? "true" : "false") + ",";
  json += "\"sistemaAtivo\":" + String(sistemaAtivoRemoto ? "true" : "false") + ",";
  json += "\"hora\":\"" + obterHoraFormatada() + "\",";
  json += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  json += "\"rssi\":" + String(WiFi.RSSI());
  json += "}";
  server.send(200, "application/json", json);
}

// Endpoint de Push Direto do Servidor para o ESP32 (Sub-segundo)
void handleApiComando() {
  String action = "";
  String rele = "rele_principal";

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
  } else if (server.hasArg("action")) {
    action = server.arg("action");
    if (server.hasArg("rele")) rele = server.arg("rele");
  }

  if (action.length() > 0) {
    executarComandoRemoto(rele.c_str(), action.c_str());
    server.send(200, "application/json", "{\"status\":\"ok\",\"origem\":\"push_direto\"}");
  } else {
    server.send(400, "application/json", "{\"error\":\"parametro action obrigatorio\"}");
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

  // Escaneia com show_hidden=true para sincronizar o canal da rede oculta
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
  Serial.println(F("Central Agroclimatica - Estufa Inteligente (ESP32-C3)"));
  Serial.println(F("======================================================="));

  // 1. Configuração do Pino de Relé (Active-Low: Inicia Desligado)
  digitalWrite(pinoRele, RELE_DESLIGADO);
  pinMode(pinoRele, OUTPUT);

  // 2. Inicialização do LCD 16x2
  inicializarLCD();
  if (lcd != nullptr) {
    lcd->setCursor(0, 0);
    lcd->print("Central Agroclim");
    lcd->setCursor(0, 1);
    lcd->print("Conectando WiFi ");
  }

  // 3. Inicialização do Sensor DHT22
  dht.begin();

  // 4. Conexão Wi-Fi
  conectarWiFi();

  if (lcd != nullptr) {
    if (WiFi.status() == WL_CONNECTED) {
      lcd->clear();
      lcd->setCursor(0, 0);
      lcd->print("WiFi Conectado! ");
      lcd->setCursor(0, 1);
      lcd->print(WiFi.localIP().toString());
    } else {
      lcd->clear();
      lcd->setCursor(0, 0);
      lcd->print("Modo Offline    ");
      lcd->setCursor(0, 1);
      lcd->print("Sem Conexao     ");
    }
  }

  // 5. Configuração do NTP
  configTime(gmtOffset_sec, daylightOffset_sec, ntpServer1, ntpServer2, ntpServer3);

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

  // 1. LEITURA DO SENSOR DHT22 (A cada 2 segundos)
  if (tempoAtual - ultimoTempoDHT >= 2000) {
    ultimoTempoDHT = tempoAtual;
    float t = dht.readTemperature();
    float h = dht.readHumidity();

    if (!isnan(t) && !isnan(h)) {
      temperatura = t;
      umidade     = h;
      dhtOk       = true;
      Serial.printf("[DHT22 ESTUFA - GPIO %d] Temp: %.1f C | Umid: %.1f %% | Rele(GPIO %d): %s | Modo: %s\n",
                    pinoDHT, temperatura, umidade, pinoRele,
                    estadoRele ? "LIGADO" : "DESLIGADO",
                    modoAutomatico ? "AUTO" : "MANUAL");
    } else {
      dhtOk = false;
      Serial.printf("[DHT22 ESTUFA - GPIO %d] Falha ao ler dados do sensor!\n", pinoDHT);
    }
  }

  // 2. LÓGICA AUTOMÁTICA DO RELÉ POR HORÁRIO
  struct tm timeinfo;
  if (getLocalTime(&timeinfo, 50)) {
    horaSincronizada = true;
    if (modoAutomatico && sistemaAtivoRemoto) {
      bool deveLigar = verificarHorarioAutomatico(timeinfo.tm_hour, timeinfo.tm_min);
      if (estadoRele != deveLigar) {
        acionarReleComMotivo(deveLigar, deveLigar ? "Horario Programado (05:00 as 17:00)" : "Fim do Fotoperiodo (17:00)");
      }
    }
  }

  // 3. ATUALIZAÇÃO DO DISPLAY LCD 16x2 (A cada 1 segundo)
  if (tempoAtual - ultimoTempoLCD >= 1000) {
    ultimoTempoLCD = tempoAtual;

    if (lcd != nullptr) {
      lcd->setCursor(0, 0);
      if (!sistemaAtivoRemoto) {
        lcd->print("! PARADA GERAL !");
      } else if (dhtOk) {
        lcd->print("T:");
        lcd->print(temperatura, 1);
        lcd->print((char)223);
        lcd->print("C U:");
        lcd->print((int)umidade);
        lcd->print("%  ");
      } else {
        lcd->print("DHT22 Lendo...  ");
      }

      lcd->setCursor(0, 1);
      static int contadorSegundos = 0;
      contadorSegundos++;

      if (!sistemaAtivoRemoto) {
        lcd->print("SISTEMA INATIVO ");
      } else if (contadorSegundos % 8 < 4) {
        if (horaSincronizada) {
          lcd->print(obterHoraFormatada());
        } else {
          lcd->print("Sinc. NTP... ");
        }
        lcd->setCursor(11, 1);
        lcd->print(modoAutomatico ? "A" : "M");
        lcd->print(estadoRele ? "[1] " : "[0] ");
      } else {
        if (WiFi.status() == WL_CONNECTED) {
          String ipStr = WiFi.localIP().toString() + "    ";
          lcd->print(ipStr.substring(0, 16));
        } else {
          lcd->print("WiFi Off...     ");
        }
      }
    }
  }

  // 4. TRANSMISSÃO DE TELEMETRIA E RECEBIMENTO DE COMANDOS (A cada 1 segundo para resposta imediata)
  if (tempoAtual - ultimoTempoTelemetria >= 1000) {
    ultimoTempoTelemetria = tempoAtual;
    enviarTelemetriaServidor();
  }

  delay(10);
}