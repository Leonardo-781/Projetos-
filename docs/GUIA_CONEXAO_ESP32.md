# 🔌 Guia Prático de Conexão: ESP32 ao Servidor GAIA

Este manual detalha o passo a passo de como integrar e enviar dados de qualquer **ESP32** para o servidor, seja pela **rede local (Wi-Fi de casa)** ou remotamente **pela Internet** (via Cloudflare Tunnel).

---

## 📌 1. Endereços do Servidor para o ESP32

Dependendo de onde a placa ESP32 estiver instalada, utilize o endereço correspondente:

| Cenário de Instalação | Protocolo | Endereço / URL no ESP32 | Porta |
| :--- | :--- | :--- | :--- |
| **Na mesma rede de casa (Bancada / Teste)** | **HTTP REST** | `http://192.168.0.105:3000/api/telemetria` | `3000` |
| **No Campo / Remoto (Internet / 4G / Outro Wi-Fi)** | **HTTPS REST** | `https://stunning-modeling-became-coverage.trycloudflare.com/api/telemetria` | `443` |
| **Rede Local via MQTT (Baixa latência / Tempo Real)** | **MQTT (TCP)** | `192.168.0.105` | `1883` |

> [!NOTE]
> O endpoint `/api/telemetria` aceita tanto pacotes em **JSON puro** quanto pacotes **criptografados com AES-128-CBC**.

---

## 📄 2. Estrutura do Payload de Telemetria

O servidor espera um payload JSON estruturado conforme o padrão do Projeto GAIA:

### 2.1. Tabela Completa dos 25 Campos Suportados

| Campo | Tipo | Descrição | Exemplo |
| :--- | :--- | :--- | :--- |
| `codSta` | `string` | Código identificador da estação (6 caracteres) | `"G00001"` |
| `ts` | `uint32` | Timestamp Unix epoch (Relógio NTP) | `1726830000` |
| `tD` | `float` | Temperatura do Ar via sensor DHT22 (°C) | `24.5` |
| `h` | `float` | Umidade Relativa do Ar via DHT22 (%) | `68.0` |
| `tB` | `float` | Temperatura do Ar via sensor BMP280 (°C) | `24.3` |
| `p` | `float` | Pressão Atmosférica via BMP280 (hPa) | `1013.2` |
| `l` | `float` | Luminosidade via sensor de luz (Lux) | `35200.0` |
| `s` | `int` | Umidade do Solo calibrada (0 a 100%) | `58` |
| `tS` | `float` | Temperatura do Solo via sensor 1-Wire (°C) | `22.1` |
| `tRef` | `float` | Temperatura de referência calculada (°C) | `24.4` |
| `dT` | `float` | Delta entre sensores de temperatura (°C) | `0.2` |
| `q` | `int` | Índice de integridade da medição (0 a 100%) | `100` |
| `po` | `float` | Ponto de Orvalho calculado (°C) | `18.1` |
| `vpd` | `float` | Déficit de Pressão de Vapor (kPa) | `0.98` |
| `et0` | `float` | Evapotranspiração de Referência FAO-56 (mm) | `0.038` |
| `etc` | `float` | Evapotranspiração da Cultura (mm) | `0.038` |
| `rs` | `float` | Radiação Solar Global ($W/m^2$) | `278.1` |
| `par` | `float` | Radiação Fotossinteticamente Ativa ($\mu mol/m^2/s$) | `584.0` |
| `rf` | `int` | Flag de Chuva recente (0 = sem chuva, 1 = chuva) | `0` |
| `rg` | `float` | Pluviômetro / Chuva acumulada (mm) | `0.0` |
| `dp` | `float` | Duração de Precipitação ou Orvalho | `0.3` |
| `at` | `bool` | Alerta de Tempestade / Tempo Severo | `false` |
| `itu` | `float` | Índice de Temperatura e Umidade (conforto térmico) | `73.1` |
| `hi` | `float` | Heat Index / Sensação Térmica (°C) | `25.4` |
| `heapMod`| `int` | Memória RAM livre do ESP32 (diagnóstico) | `412` |

---

### 2.2. Como o ESP32 Cifra e o Servidor Decifra (AES-128-CBC)

O ESP32 envia o pacote HTTP POST com o JSON contendo o campo `"data"` em Base64:
```json
{
  "data": "k83j...=="
}
```

O servidor decifra seguindo este protocolo de segurança:
1. **Lê o campo `"data"`** e decodifica a string Base64 para buffer de bytes.
2. **Separação do IV e Ciphertext**:
   - **Bytes 0 a 15 (16 bytes):** Vetor de Inicialização (`iv = bytes[0..15]`).
   - **Bytes 16 até o fim:** Dados cifrados (`ciphertext = bytes[16..fim]`).
3. **Decodificação AES-128-CBC**:
   - Chave simétrica oficial: `GaiaAgroIoT2026!` (16 bytes = 128 bits). O servidor mantém fallback automático para compatibilidade.
   - Remoção de preenchimento: **PKCS#7**.
4. **Parsing JSON & Autenticação de Token:** O texto plano resultante é convertido no JSON e o `token` da estação é validado.

---

### 2.3. Autenticação Criptográfica e Token Único do Projeto GAIA

**1. Chave Criptográfica AES-128 Oficial (`GaiaAgroIoT2026!`):**
- A chave simétrica oficial de 16 bytes do Projeto GAIA (`GaiaAgroIoT2026!`) garante confidencialidade de ponta a ponta e integridade.
- O servidor possui descriptografia de dupla camada com fallback automático para a chave legada, garantindo 100% de disponibilidade.

**2. Token Unificado de Projeto (`GAIA_TOKEN_2026_AGRO`):**
- **Token Único para Todas as Estações:** Para simplificar a implantação em escala no campo, todas as estações do Projeto GAIA compartilham o token mestre:
  `GAIA_TOKEN_2026_AGRO`
- Qualquer ESP32 transmitindo com este token é **automaticamente validado e autorizado** pelo servidor para qualquer código de estação (`codSta`), sem necessidade de cadastrar tokens individuais manualmente para cada placa.
- **Como o ESP32 envia:**
  - **No JSON Criptografado (Embutido):** Adicionado automaticamente no firmware como `"token": "GAIA_TOKEN_2026_AGRO"`.
  - **No Cabeçalho HTTP:** `X-Station-Token: GAIA_TOKEN_2026_AGRO`.

---

## 🚀 3. Opção A: Firmware Oficial (`TX Telemetria.c` e `TX_Telemetria.ino`)

O código oficial do microcontrolador já foi **completamente atualizado e configurado** no repositório.

### Modificações Realizadas no Código C:
1. **Constantes Globais (Linhas 99 a 101):**
```cpp
#define DEFAULT_SERVER_URL "https://stunning-modeling-became-coverage.trycloudflare.com/api/telemetria"
#define DEFAULT_CRYPTO_KEY "GaiaAgroIoT2026!"
#define GAIA_PROJECT_TOKEN "GAIA_TOKEN_2026_AGRO"
```
2. **Estrutura de Configuração (Linha 145):**
```cpp
String chaveCrypto = DEFAULT_CRYPTO_KEY; // Chave padrão de 16 caracteres
```
3. **Cabeçalho HTTP no Envio (Linha 1479):**
```cpp
http.addHeader("Content-Type", "application/json");
http.addHeader("X-Station-Token", GAIA_PROJECT_TOKEN);
```
4. **Montagem do Payload JSON (Linha 1581):**
```cpp
doc["codSta"] = cfg.estacao;
doc["token"]  = GAIA_PROJECT_TOKEN;
doc["ts"]     = ts;
```

### Como Trocar entre Rede Local e Nuvem:
- **Pela Nuvem (Cloudflare):** Já vem configurado por padrão com `https://stunning-modeling-became-coverage.trycloudflare.com/api/telemetria`.
- **Pela Rede Local de Bancada:** Caso queira apontar diretamente para o servidor local sem passar pela internet, basta alterar `DEFAULT_SERVER_URL` para:
  `http://192.168.0.105:3000/api/telemetria`
- **Ou pelo Portal Captivo Wi-Fi:** Segure o botão no **GPIO 15** no boot, conecte na rede Wi-Fi `GAIA-TX-[MAC]`, abra `http://192.168.4.1` e informe a URL desejada. As alterações são salvas na memória NVS permanente do ESP32.

---

## 💻 4. Opção B: Exemplo de Código Simples (HTTP REST Direto)

Se você quiser criar um novo firmware do zero ou testar um ESP32 secundário enviando medições para o painel em tempo real:

```cpp
/**
 * Exemplo de Envio Direto via HTTP REST para o Servidor GAIA
 * Placa: ESP32 Dev Module
 * Requer biblioteca: ArduinoJson (v6 ou v7)
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// Configurações de Wi-Fi
const char* ssid = "SEU_WIFI_AQUI";
const char* password = "SUA_SENHA_AQUI";

// URL do Servidor (Local ou Cloudflare)
const char* serverUrl = "http://192.168.0.105:3000/api/telemetria";
// const char* serverUrl = "https://stunning-modeling-became-coverage.trycloudflare.com/api/telemetria";

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.print("Conectando ao Wi-Fi");
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWi-Fi Conectado! IP do ESP32: " + WiFi.localIP().toString());
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin(serverUrl);
    http.addHeader("Content-Type", "application/json");
    http.setTimeout(8000);

    // 1. Coleta ou Simulação de Sensores
    float tempAr = 24.5;
    float umidAr = 68.0;
    float pressao = 1013.25;
    float lux = 22000.0;
    int solo = 55;
    float tempSolo = 22.0;

    // 2. Cálculos Agroclimáticos Básicos (VPD e Orvalho)
    float es = 0.61078 * exp((17.27 * tempAr) / (tempAr + 237.3));
    float ea = es * (umidAr / 100.0);
    float vpd = es - ea;

    float alpha = ((17.27 * tempAr) / (237.7 + tempAr)) + log(umidAr / 100.0);
    float pontoOrvalho = (237.7 * alpha) / (17.27 - alpha);

    // 3. Montagem do JSON
    JsonDocument doc;
    doc["codSta"] = "G00001";
    doc["ts"] = (uint32_t)(millis() / 1000); // Em produção, utilize NTP
    doc["tD"] = tempAr;
    doc["h"] = umidAr;
    doc["p"] = pressao;
    doc["l"] = lux;
    doc["s"] = solo;
    doc["tS"] = tempSolo;
    doc["tRef"] = tempAr;
    doc["vpd"] = vpd;
    doc["po"] = pontoOrvalho;
    doc["et0"] = 0.012;
    doc["q"] = 100;
    doc["heapMod"] = ESP.getFreeHeap() % 1000;

    String requestBody;
    serializeJson(doc, requestBody);

    Serial.println("\nEnviando pacote ao servidor...");
    int httpResponseCode = http.POST(requestBody);

    if (httpResponseCode > 0) {
      String response = http.getString();
      Serial.printf("Resposta do Servidor [%d]: %s\n", httpResponseCode, response.c_str());
    } else {
      Serial.printf("Falha no envio HTTP. Código de erro: %d (%s)\n", 
                    httpResponseCode, http.errorToString(httpResponseCode).c_str());
    }

    http.end();
  } else {
    Serial.println("Wi-Fi desconectado. Tentando reconectar...");
    WiFi.reconnect();
  }

  // Intervalo de envio (ex: a cada 10 segundos para teste)
  delay(10000);
}
```

---

## 📡 5. Opção C: Exemplo de Código via MQTT (Mosquitto)

Caso deseje comunicação contínua bidirecional de altíssima velocidade e baixíssimo consumo:

```cpp
/**
 * Exemplo de Envio via MQTT para o Servidor
 * Requer biblioteca: PubSubClient
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

const char* ssid = "SEU_WIFI";
const char* password = "SUA_SENHA";

// IP do notebook servidor na rede de casa
const char* mqttServer = "192.168.0.105";
const int   mqttPort = 1883;

WiFiClient espClient;
PubSubClient client(espClient);

void setup() {
  Serial.begin(115200);
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) { delay(500); }
  
  client.setServer(mqttServer, mqttPort);
}

void reconectar() {
  while (!client.connected()) {
    Serial.print("Conectando ao broker MQTT...");
    if (client.connect("ESP32_GAIA_G00001")) {
      Serial.println("Conectado com sucesso!");
    } else {
      Serial.print("Falha rc=");
      Serial.print(client.state());
      delay(2000);
    }
  }
}

void loop() {
  if (!client.connected()) {
    reconectar();
  }
  client.loop();

  // Publica dados a cada 5 segundos
  static unsigned long lastMsg = 0;
  if (millis() - lastMsg > 5000) {
    lastMsg = millis();

    JsonDocument doc;
    doc["estacao"] = "G00001";
    doc["temp"] = 25.3;
    doc["umid"] = 62.0;
    doc["solo"] = 48;

    char buffer[256];
    serializeJson(doc, buffer);

    client.publish("gaia/telemetria", buffer);
    Serial.println("Mensagem publicada via MQTT!");
  }
}
```

---

## 🔍 6. Como Monitorar e Validar os Envios em Tempo Real

Para ter certeza absoluta de que o servidor está recebendo e gravando os dados enviados pelo seu ESP32:

### 1. Monitorar os logs do servidor pelo terminal (PowerShell no Windows)
Abra o PowerShell e execute:
```powershell
ssh leo@192.168.0.105 "docker logs -f gaia-server"
```
Assim que o ESP32 enviar um pacote, aparecerá instantaneamente no terminal:
```text
[TELEMETRIA] Recebida de G00001 | T:24.5°C | U:65% | Solo:55% | VPD:1.08kPa | ET0:0.012mm
```

### 2. Pelo Dashboard Web
Basta abrir o link:
👉 **[https://stunning-modeling-became-coverage.trycloudflare.com](https://stunning-modeling-became-coverage.trycloudflare.com)**  
O badge superior exibirá **"Tempo Real Conectado"** e todos os gráficos e cards se moverão no momento exato em que o ESP32 transmitir.

---

## 🛠️ 7. Guia Rápido de Resolução de Problemas (Troubleshooting)

| Sintoma no ESP32 | Causa Mais Provável | O que fazer |
| :--- | :--- | :--- |
| `HTTP Error -1 (Connection Refused)` | IP incorreto ou porta errada | Verifique se o notebook está ligado no IP `192.168.0.105` e porta `3000`. |
| `Falha na descriptografia AES-128` | Chave divergente | Certifique-se de que a chave no ESP32 seja exatamente `MARIACRYPTOKEY12`. |
| `WiFi.status() != WL_CONNECTED` | Falha de sinal ou senha do roteador | Aproxime o ESP32 do roteador de casa. O ESP32 opera apenas em redes **2.4 GHz**. |
| Envio via Internet falha com HTTPS | Validação de certificado SSL no ESP32 | No código com `HTTPClient`, adicione `http.setInsecure();` para ignorar verificação de root certificate da Cloudflare. |
