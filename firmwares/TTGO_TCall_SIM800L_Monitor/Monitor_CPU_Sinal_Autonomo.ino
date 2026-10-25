/**
 * ============================================================================
 * PROJETO GAIA / SERVIDOR STI - TELEMETRIA 100% GPRS CELULAR (SIM800L)
 * ============================================================================
 * COMUNICAÇÃO EXCLUSIVA VIA CHIP CELULAR (GPRS / SIM800L) - SEM USO DE WI-FI.
 * Rádios Wi-Fi e Bluetooth permanecem 100% DESLIGADOS (WiFi.mode(WIFI_OFF)).
 * 
 * Envia telemetria periódica via dados móveis para o Servidor STI:
 * - Nuvem HTTPS: https://server1.taila7d06b.ts.net/ttgo/api/report
 * ============================================================================
 */

#define TINY_GSM_MODEM_SIM800

#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <ArduinoJson.h>
#include <TinyGsmClient.h>

#define SSLCLIENT_INSECURE_ONLY
#define SSLCLIENT_HALF_DUPLEX
#include <ESP_SSLClient.h>

// ----------------------------------------------------------------------------
// PINAGEM HARDWARE LILYGO ESP32 TTGO T-CALL V1.3 / V1.4
// ----------------------------------------------------------------------------
#define MODEM_RST            5
#define MODEM_PWRKEY         4
#define MODEM_POWER_ON       23
#define MODEM_TX             27
#define MODEM_RX             26

#define I2C_SDA              21
#define I2C_SCL              22
#define IP5306_ADDR          0x75
#define IP5306_REG_SYS_CTL0  0x00

#define SerialMon Serial
#define SerialAT  Serial1

// ----------------------------------------------------------------------------
// CONFIGURAÇÃO DO SERVIDOR STI (NUVEM HTTPS)
// ----------------------------------------------------------------------------
const char serverHost[] = "server1.taila7d06b.ts.net";
const int  serverPort   = 443;
const char serverPath[] = "/ttgo/api/report";

// APN padrão Vivo Brasil (Telemig Celular em MG)
String apnAtual  = "zap.vivo.com.br";
String userAtual = "vivo";
String passAtual = "vivo";

// ----------------------------------------------------------------------------
// CLIENTES DE REDE CELULAR
// ----------------------------------------------------------------------------
TinyGsm modem(SerialAT);
TinyGsmClient gsmClient(modem);
ESP_SSLClient sslClient;

// Estruturas de Dados
struct TelemetriaModem {
    int csq = 0;
    int ber = 99;
    int rssiDbm = -113;
    int pctSinal = 0;
    String qualidade = "Buscando...";
    String operadora = "--";
    String simStatus = "Verificando...";
    String regStatus = "Desconectado";
    int tensaoBateriaMv = 0;
    int pctBateria = 0;
    String imei = "--";
    bool gprsConectado = false;
};

struct TelemetriaESP32 {
    uint32_t cpuFreqMHz = 240;
    float coreTempC = 0.0;
    uint32_t heapTotal = 327680;
    uint32_t heapLivre = 0;
    uint32_t heapMinLivre = 0;
    float heapUsoPct = 0.0;
    uint32_t uptimeSegundos = 0;
    uint32_t loopsPorSegundo = 0;
    String macAddress = "";
};

TelemetriaModem modData;
TelemetriaESP32 espData;

unsigned long lastReportMillis = 0;
const unsigned long REPORT_INTERVAL_MS = 10000;

unsigned long lastLoopSec = 0;
uint32_t loopCounter = 0;
uint32_t currentLoopsPerSec = 0;

// ----------------------------------------------------------------------------
// GERENCIAMENTO ENERGÉTICO DO PMU IP5306
// ----------------------------------------------------------------------------
bool setupIP5306() {
    Wire.begin(I2C_SDA, I2C_SCL);
    Wire.beginTransmission(IP5306_ADDR);
    Wire.write(IP5306_REG_SYS_CTL0);
    Wire.write(0x37); // Mantém o Boost 5V sempre ativo para alimentar o SIM800L
    return (Wire.endTransmission() == 0);
}

void powerOnModem() {
    SerialMon.println("[ENERGIA] Verificando alimentacao do modem SIM800L...");
    pinMode(MODEM_POWER_ON, OUTPUT);
    digitalWrite(MODEM_POWER_ON, HIGH);

    pinMode(MODEM_RST, OUTPUT);
    digitalWrite(MODEM_RST, HIGH);

    // Testa se o modem já está ligado e respondendo antes de pulsar PWRKEY
    SerialAT.begin(115200, SERIAL_8N1, MODEM_RX, MODEM_TX);
    delay(200);
    SerialAT.println("AT");
    delay(300);
    bool jaLigado = false;
    while (SerialAT.available()) {
        char c = SerialAT.read();
        if (c == 'O' || c == 'K') jaLigado = true;
    }

    if (!jaLigado) {
        SerialMon.println("[ENERGIA] Modem desligado. Enviando pulso PWRKEY (1s)...");
        pinMode(MODEM_PWRKEY, OUTPUT);
        digitalWrite(MODEM_PWRKEY, HIGH);
        delay(100);
        digitalWrite(MODEM_PWRKEY, LOW);
        delay(1000);
        digitalWrite(MODEM_PWRKEY, HIGH);
        delay(3000);
    } else {
        SerialMon.println("[ENERGIA] Modem SIM800L ja esta ligado e operante.");
    }
}

String sendAT(const String& cmd, unsigned long timeout = 2000) {
    while (SerialAT.available()) SerialAT.read();
    SerialAT.println(cmd);
    String res = "";
    unsigned long start = millis();
    while (millis() - start < timeout) {
        while (SerialAT.available()) {
            res += (char)SerialAT.read();
        }
        if (res.indexOf("OK") != -1 || res.indexOf("ERROR") != -1) {
            delay(30);
            while (SerialAT.available()) res += (char)SerialAT.read();
            break;
        }
    }
    return res;
}

// ----------------------------------------------------------------------------
// ATUALIZAÇÃO DAS MÉTRICAS DE CPU E SINAL DO MODEM
// ----------------------------------------------------------------------------
void coletarMetricasESP32() {
    espData.cpuFreqMHz = getCpuFrequencyMhz();
    espData.coreTempC = temperatureRead();
    espData.heapLivre = ESP.getFreeHeap();
    espData.heapMinLivre = ESP.getMinFreeHeap();
    espData.heapTotal = 327680;
    espData.heapUsoPct = 100.0 - ((float)espData.heapLivre / (float)espData.heapTotal * 100.0);
    espData.uptimeSegundos = millis() / 1000;
    espData.loopsPorSegundo = currentLoopsPerSec;
}

void coletarMetricasSIM800L() {
    // 1. Sinal CSQ
    String csqResp = sendAT("AT+CSQ");
    int csqIdx = csqResp.indexOf("+CSQ: ");
    if (csqIdx != -1) {
        int commaIdx = csqResp.indexOf(',', csqIdx);
        if (commaIdx != -1) {
            modData.csq = csqResp.substring(csqIdx + 6, commaIdx).toInt();
            modData.ber = csqResp.substring(commaIdx + 1).toInt();
            if (modData.csq == 99 || modData.csq == 0) {
                modData.rssiDbm = -113;
                modData.pctSinal = 0;
                modData.qualidade = (modData.csq == 0) ? "Buscando Torre..." : "Sem Sinal";
            } else {
                modData.rssiDbm = -113 + (2 * modData.csq);
                modData.pctSinal = constrain(map(modData.csq, 2, 31, 5, 100), 0, 100);
                if (modData.csq >= 20)      modData.qualidade = "Excelente";
                else if (modData.csq >= 14) modData.qualidade = "Bom";
                else if (modData.csq >= 8)  modData.qualidade = "Regular";
                else                        modData.qualidade = "Fraco";
            }
        }
    }

    // 2. Status do Chip SIM (+CPIN?)
    String cpinResp = sendAT("AT+CPIN?");
    if (cpinResp.indexOf("READY") != -1) {
        modData.simStatus = "Pronto (Desbloqueado)";
    } else if (cpinResp.indexOf("SIM PIN") != -1) {
        modData.simStatus = "Bloqueado (Requer PIN)";
    } else if (cpinResp.indexOf("ERROR") != -1) {
        modData.simStatus = "Nenhum Chip Detectado";
    }

    // 3. Operadora (+COPS?)
    String copsResp = sendAT("AT+COPS?");
    int q1 = copsResp.indexOf('"');
    if (q1 != -1) {
        int q2 = copsResp.indexOf('"', q1 + 1);
        if (q2 != -1) {
            modData.operadora = copsResp.substring(q1 + 1, q2);
        }
    } else {
        if (modData.operadora == "--" && modData.csq > 0 && modData.csq < 99) {
            modData.operadora = "Buscando Operadora...";
        }
    }

    // 4. Registro de Rede (+CREG? e +CGREG?)
    String cregResp = sendAT("AT+CREG?");
    String cgregResp = sendAT("AT+CGREG?");

    char statCreg = '0';
    int c1 = cregResp.indexOf("+CREG: ");
    if (c1 != -1) {
        int comma = cregResp.indexOf(',', c1);
        if (comma != -1) statCreg = cregResp.charAt(comma + 1);
    }

    char statCgreg = '0';
    int c2 = cgregResp.indexOf("+CGREG: ");
    if (c2 != -1) {
        int comma = cgregResp.indexOf(',', c2);
        if (comma != -1) statCgreg = cgregResp.charAt(comma + 1);
    }

    if (statCreg == '1' || statCgreg == '1') {
        modData.regStatus = "Registrado (Rede Local)";
    } else if (statCreg == '5' || statCgreg == '5') {
        modData.regStatus = "Registrado (Roaming)";
    } else if (statCreg == '2' || statCgreg == '2') {
        modData.regStatus = "Buscando Torre Celular...";
    } else if (statCreg == '3' || statCgreg == '3') {
        modData.regStatus = "Sinal Insuficiente / Negado";
    } else {
        modData.regStatus = "Sem Registro";
    }

    // 5. Bateria (+CBC)
    String cbcResp = sendAT("AT+CBC");
    int cbcIdx = cbcResp.indexOf("+CBC: ");
    if (cbcIdx != -1) {
        int comma1 = cbcResp.indexOf(',', cbcIdx);
        int comma2 = cbcResp.indexOf(',', comma1 + 1);
        if (comma1 != -1 && comma2 != -1) {
            modData.pctBateria = cbcResp.substring(comma1 + 1, comma2).toInt();
            modData.tensaoBateriaMv = cbcResp.substring(comma2 + 1).toInt();
        }
    }

    // 6. IMEI
    if (modData.imei == "--" || modData.imei.length() < 5) {
        String imeiResp = sendAT("AT+GSN");
        imeiResp.replace("\r", "");
        imeiResp.replace("\n", "");
        imeiResp.replace("OK", "");
        imeiResp.replace("AT+GSN", "");
        imeiResp.trim();
        if (imeiResp.length() >= 8) {
            modData.imei = imeiResp;
        }
    }
}

// ----------------------------------------------------------------------------
// GERAÇÃO DO PAYLOAD JSON
// ----------------------------------------------------------------------------
String gerarPayloadJSON() {
    JsonDocument doc;
    doc["csq"]             = modData.csq;
    doc["dbm"]             = modData.rssiDbm;
    doc["sinal"]           = modData.qualidade;
    doc["pct_sinal"]       = modData.pctSinal;
    doc["op"]              = modData.operadora;
    doc["sim"]             = modData.simStatus;
    doc["temp"]            = serialized(String(espData.coreTempC, 1));
    doc["heap_livre"]      = espData.heapLivre;
    doc["heap_pct"]        = serialized(String(espData.heapUsoPct, 1));
    doc["uptime"]          = espData.uptimeSegundos;
    doc["tensaoBateriaMv"] = modData.tensaoBateriaMv;
    doc["pctBateria"]      = modData.pctBateria;
    doc["imei"]            = modData.imei;
    doc["fonte"]           = "GPRS Celular (SIM800L Exclusivo)";
    doc["loops_sec"]       = espData.loopsPorSegundo;
    doc["mac"]             = espData.macAddress;

    String jsonStr;
    serializeJson(doc, jsonStr);
    return jsonStr;
}

// ----------------------------------------------------------------------------
// CONEXÃO GPRS ROBUSTA VIA TINYGSM
// ----------------------------------------------------------------------------
bool ativarGPRSNativo() {
    if (modData.gprsConectado && modem.isGprsConnected()) {
        return true;
    }

    SerialMon.println("[GPRS] Verificando conexao de dados celulares...");
    
    // Garante que o anexo GPRS está ativo
    sendAT("AT+CGATT=1", 3000);

    SerialMon.printf("[GPRS] Conectando dados GPRS com APN '%s'...\n", apnAtual.c_str());
    if (!modem.gprsConnect(apnAtual.c_str(), userAtual.c_str(), passAtual.c_str())) {
        SerialMon.println("[GPRS] Falha ao ativar conexao GPRS.");
        modData.gprsConectado = false;
        return false;
    }

    IPAddress ip = modem.localIP();
    SerialMon.printf("[GPRS] Conexao GPRS ESTABELECIDA! IP Celular: %s\n", ip.toString().c_str());
    modData.gprsConectado = true;
    return true;
}

// ----------------------------------------------------------------------------
// TRANSMISSÃO HTTPS DIRETA AO SERVIDOR STI
// ----------------------------------------------------------------------------
bool enviarReportHTTPS(const String& payload) {
    if (!ativarGPRSNativo()) {
        return false;
    }

    SerialMon.printf("[HTTPS GPRS] Estabelecendo sessao segura com %s:%d ...\n", serverHost, serverPort);

    gsmClient.setTimeout(15000);
    sslClient.setTimeout(15000);
    sslClient.setInsecure();
    sslClient.setBufferSizes(1024, 512);
    sslClient.setDebugLevel(1);
    sslClient.setClient(&gsmClient);

    unsigned long tStart = millis();
    if (!sslClient.connect(serverHost, serverPort)) {
        SerialMon.println("[HTTPS GPRS] Erro ao conectar no host seguro.");
        sslClient.stop();
        return false;
    }

    SerialMon.printf("[HTTPS GPRS] TLS Conectado em %lu ms. Enviando POST HTTP...\n", millis() - tStart);

    sslClient.print("POST ");
    sslClient.print(serverPath);
    sslClient.print(" HTTP/1.1\r\n");
    sslClient.print("Host: ");
    sslClient.print(serverHost);
    sslClient.print("\r\n");
    sslClient.print("User-Agent: ESP32-TTGO-SIM800L-STI/1.0\r\n");
    sslClient.print("Content-Type: application/json\r\n");
    sslClient.print("Connection: close\r\n");
    sslClient.print("Content-Length: ");
    sslClient.print(payload.length());
    sslClient.print("\r\n\r\n");
    sslClient.print(payload);

    unsigned long waitResp = millis();
    while (!sslClient.available() && millis() - waitResp < 8000) {
        delay(20);
    }

    String response = "";
    int httpCode = 0;
    while (sslClient.available()) {
        String line = sslClient.readStringUntil('\n');
        if (line.startsWith("HTTP/1.1 ") || line.startsWith("HTTP/1.0 ")) {
            httpCode = line.substring(9, 12).toInt();
        }
        response += line + "\n";
    }
    sslClient.stop();

    SerialMon.printf("[HTTPS GPRS] Resposta Servidor STI: Code %d\n", httpCode);

    if (httpCode >= 200 && httpCode < 400) {
        int jsonIdx = response.indexOf('{');
        if (jsonIdx != -1) {
            String jsonBody = response.substring(jsonIdx);
            JsonDocument docResp;
            if (deserializeJson(docResp, jsonBody) == DeserializationError::Ok) {
                if (docResp.containsKey("cmd")) {
                    const char* cmd = docResp["cmd"];
                    SerialMon.printf("[STI COMANDO AT RECEBIDO]: %s\n", cmd);
                    sendAT(cmd, 2500);
                }
            }
        }
        return true;
    }

    return false;
}

// ----------------------------------------------------------------------------
// SETUP
// ----------------------------------------------------------------------------
void setup() {
    SerialMon.begin(115200);
    delay(500);

    SerialMon.println("\n========================================================");
    SerialMon.println("  SERVIDOR STI - TTGO T-CALL V1.3/V1.4 (GPRS EXCLUSIVO) ");
    SerialMon.println("========================================================");

    // 1. Obter MAC e desligar completamente rádios Wi-Fi e Bluetooth
    SerialMon.print("[1/4] Desativando Wi-Fi e Bluetooth... ");
    espData.macAddress = WiFi.macAddress();
    WiFi.mode(WIFI_OFF);
    WiFi.disconnect(true);
    btStop();
    SerialMon.println("OK (Rádios RF locais 100% DESLIGADOS)");

    // 2. Inicializar PMU IP5306
    SerialMon.print("[2/4] Configurando Gerenciador de Energia (IP5306)... ");
    if (setupIP5306()) {
        SerialMon.println("OK (Alimentacao 5V Continua do SIM800L Ativa)");
    } else {
        SerialMon.println("AVISO (Operacao direta)");
    }

    // 3. Ligar Modem SIM800L via hardware PWRKEY (somente se não estiver ligado)
    SerialMon.println("[3/4] Acionando alimentacao do SIM800L...");
    powerOnModem();

    // 4. Inicializar UART SerialAT a 115200
    SerialMon.println("[4/4] Inicializando UART SerialAT a 115200...");
    SerialAT.begin(115200, SERIAL_8N1, MODEM_RX, MODEM_TX);
    delay(500);
    sendAT("ATE0");
    sendAT("AT+CBAND=\"ALL_BAND\"");
    sendAT("AT+COPS=0");
    sendAT("AT+CREG=1");
    sendAT("AT+CGREG=1");
    modem.init();

    SerialMon.println("\nInicializacao concluida. Coletando status inicial do modem...");
    coletarMetricasESP32();
    coletarMetricasSIM800L();

    SerialMon.printf("  Chip SIM: %s\n", modData.simStatus.c_str());
    SerialMon.printf("  Operadora: %s\n", modData.operadora.c_str());
    SerialMon.printf("  Sinal CSQ: %d (%d dBm - %s)\n", modData.csq, modData.rssiDbm, modData.qualidade.c_str());
    SerialMon.printf("  IMEI: %s\n", modData.imei.c_str());
    SerialMon.printf("  Bateria: %d mV (%d%%)\n", modData.tensaoBateriaMv, modData.pctBateria);
    SerialMon.println("========================================================\n");
}

// ----------------------------------------------------------------------------
// LOOP PRINCIPAL
// ----------------------------------------------------------------------------
void loop() {
    loopCounter++;

    // Cálculo da taxa de loops por segundo
    if (millis() - lastLoopSec >= 1000) {
        currentLoopsPerSec = loopCounter;
        loopCounter = 0;
        lastLoopSec = millis();
    }

    // Rotina periódica de Telemetria e Transmissão GPRS ao Servidor STI (10s)
    if (millis() - lastReportMillis >= REPORT_INTERVAL_MS) {
        lastReportMillis = millis();

        coletarMetricasESP32();
        coletarMetricasSIM800L();

        String payload = gerarPayloadJSON();

        // Barra visual de intensidade de sinal (0 a 10 barras)
        int barras = map(constrain(modData.csq, 0, 31), 0, 31, 0, 10);
        String barraStr = "[";
        for (int b = 0; b < 10; b++) {
            barraStr += (b < barras) ? "#" : ".";
        }
        barraStr += "]";

        bool sucesso = false;
        bool redeRegistrada = (modData.regStatus.indexOf("Registrado") != -1);

        if (redeRegistrada && modData.csq >= 5 && modData.simStatus.indexOf("Pronto") != -1) {
            SerialMon.printf("📡 SINAL: CSQ %d (%d dBm) %s %d%% | %s | %s\n", 
                             modData.csq, modData.rssiDbm, barraStr.c_str(), modData.pctSinal, modData.operadora.c_str(), modData.regStatus.c_str());
            sucesso = enviarReportHTTPS(payload);
        } else {
            SerialMon.printf("📡 SINAL: CSQ %d (%d dBm) %s %d%% | Status: %s | Op: %s\n", 
                             modData.csq, modData.rssiDbm, barraStr.c_str(), modData.pctSinal, modData.regStatus.c_str(), modData.operadora.c_str());
        }

        SerialMon.printf("[TELEMETRIA GPRS - Status %s]: %s\n\n", sucesso ? "OK" : "PENDENTE", payload.c_str());
    }

    // Ponte serial transparente bidirecional para testes diretos no terminal
    while (SerialAT.available()) {
        SerialMon.write(SerialAT.read());
    }
    while (SerialMon.available()) {
        SerialAT.write(SerialMon.read());
    }
}
