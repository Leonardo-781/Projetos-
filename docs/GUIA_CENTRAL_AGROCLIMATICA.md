# 🌿 Central de Automação Agroclimática (Estufa & Regulador Térmico)

Sistema completo de telemetria em tempo real, armazenamento em banco de dados relacional e controle remoto para dois microcontroladores ESP32:
1. **Estufa Inteligente** (ESP32-C3 Super Mini — 1 Relé + DHT22 + LCD 16x2)
2. **Regulador Térmico & Fotoperíodo** (ESP32 Dev Module — 3 Relés + DHT22 + LCD 20x4)

---

## 🌐 Endereços de Acesso ao Painel de Controle

- **Acesso na Rede Local (Wi-Fi de casa/laboratório):**  
  👉 **[http://192.168.0.105:3001](http://192.168.0.105:3001)**

- **Acesso Público Seguro pela Internet (Celular / 4G / Fora de casa):**  
  👉 **[https://legacy-based-advertiser-collectibles.trycloudflare.com](https://legacy-based-advertiser-collectibles.trycloudflare.com)**  
  *(Túnel Cloudflare HTTPS criptografado com inicialização automática no boot do notebook)*

---

## 🚀 Principais Recursos do Sistema

### 1. Dois Sistemas 100% Separados e Independentes
- **Aba "Estufa Inteligente"**: Exibe temperatura e umidade da estufa, status do relé principal (iluminação/aquecimento) e histórico.
- **Aba "Regulador Térmico"**: Exibe temperatura e umidade do ambiente regulado, controle e monitoramento dos 3 relés:
  - **Relé 1 (Aquecedor - Lâmpada 220V no GPIO 32)**: Liga se Temp $\le 26.0^\circ\text{C}$ / Desliga se $\ge 28.0^\circ\text{C}$.
  - **Relé 2 (Cooler - Ventilação 12V no GPIO 14)**: Liga se Temp $\ge 28.0^\circ\text{C}$ / Desliga se $\le 26.0^\circ\text{C}$.
  - **Relé 3 (Fotoperíodo - Fita LED no GPIO 18)**: Ciclo automático de 12 horas de luz (05:00 às 17:00).

---

### 2. Banco de Dados de Registros (PostgreSQL)

O sistema conta com banco de dados estruturado com duas estratégias complementares:

1. **Leituras do Ambiente a cada 15 Minutos (`edmar_leituras`)**:
   - Salva a temperatura e a umidade exatas a cada 15 minutos de forma contínua 24 horas por dia.
   - Alimenta os gráficos temporais com histórico selecionável de **24 horas**, **7 dias** e **30 dias**.

2. **Registro Imediato de Eventos dos Relés (`edmar_eventos_reles`)**:
   - **Toda vez que qualquer relé for acionado ou desligado**, um evento é registrado no banco de dados com:
     - Data e Hora exata
     - Sistema (`estufa` ou `regulador`)
     - Dispositivo / Relé (`rele_principal`, `aquecedor`, `cooler`, `led`)
     - Estado (`LIGADO` ou `DESLIGADO`)
     - Modo (`AUTOMATICO` ou `MANUAL`)
     - Temperatura e Umidade no instante da comutação
     - Motivo da comutação (ex: *"Temperatura <= 26.0°C"*, *"Fotoperíodo 05:00h"*, *"Comando manual via painel web"*, *"Parada Geral do Sistema"*)
   - **Exportação CSV**: Botão na aba de logs para baixar a planilha completa com um clique.

---

### 3. Controle Manual e Parada Geral de Emergência

- **Controle por Relé**: Em qualquer momento, você pode clicar em `[Ligar]` ou `[Desligar]` para assumir o controle forçado, ou clicar em `[Modo Automático]` para devolver a inteligência aos sensores e horários.
- **Botão de Desativação Geral (Parada de Emergência)**:
  - Cada sistema possui um botão mestre de destaque:
    - `[🔴 DESATIVAR ESTUFA (PARADA GERAL)]`
    - `[🔴 DESATIVAR REGULADOR (PARADA GERAL)]`
  - Ao clicar, o servidor e os ESP32 forçam imediatamente todos os relés para **DESLIGADO**, bloqueiam novas comutações e exibem um alerta de parada no display LCD.
  - Ao clicar em `[🟢 REATIVAR SISTEMA]`, o controle automático e térmico volta a operar normalmente.

---

### 4. Blindagem e Autonomia Offline dos ESP32

Se o roteador reiniciar ou a internet cair:
- Os microcontroladores **não travam e continuam funcionando de forma 100% autônoma**, mantendo a histerese térmica, o fotoperíodo e as leituras nos displays LCD.
- Quando o Wi-Fi restabelece, eles voltam a sincronizar e transmitir automaticamente para o servidor.

---

## 💻 Código dos ESP32 Atualizados

Os códigos com a integração pronta para gravação estão salvos em:

1. **Estufa**: `C:\Users\Leonardo\OneDrive\Documentos\VS Code\Edmar\Estufa\Estufa.ino`
2. **Regulador**: `C:\Users\Leonardo\OneDrive\Documentos\VS Code\Edmar\Regulador_de_Temperatura\Regulador_de_Temperatura.ino`

*(Os arquivos originais foram preservados com a extensão `.bak` por segurança).*

### Como gravar na placa:
1. Abra o arquivo `.ino` desejado no **Arduino IDE** ou **VS Code**.
2. Selecione a placa correspondente:
   - Para a Estufa: **ESP32C3 Dev Module**
   - Para o Regulador: **ESP32 Dev Module**
3. Conecte o cabo USB e clique em **Carregar (Upload)**.
4. Ao ligar, o display LCD mostrará o IP local e iniciará a transmissão automática para o servidor.
