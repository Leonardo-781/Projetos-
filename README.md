# 🌾 Monorepo: Central Agroclimática & Estações IoT

Repositório centralizado contendo todos os sistemas de automação agroclimática, controle de estufas, câmaras de fermentação biológica e visualização geoespacial em tempo real.

---

## 📁 Estrutura de Diretórios

```text
├── 🌐 agroclima_app/           # Central Agroclimática (Estufa & Câmara de Fermentação - Porta 3001)
│   ├── server.js               # API REST, Ingestão de Telemetria e Fila de Comandos
│   ├── Dockerfile              # Imagem Docker Node.js 20 Alpine
│   ├── package.json            # Dependências (Express, pg, cors)
│   └── public/index.html       # Painel de controle web em tempo real
│
├── 🌾 gaia/                    # Projeto GAIA: Estação Meteorológica & Solo (Porta 3000)
│   ├── server.js               # Backend Node.js de Ingestão e WebSockets
│   └── public/                 # Dashboard web
│
├── 🗺️ frontend/                # Frontend React + Vite (Estilo ATGH2O)
│   ├── src/                    # Aplicação React com Mapa Satélite em Tela Cheia
│   └── package.json            # Dependências (Leaflet, Lucide, Tailwind)
│
├── 🔌 firmwares/               # Códigos C++ dos Microcontroladores (ESP32-C3 Super Mini)
│   ├── Estufa/                 # ESP32-C3: 1 Relé + Sensor DHT22 + LCD 16x2
│   │   └── Estufa.ino          # Firmware com túnel HTTPS redundante
│   └── Camara_Fermentacao/     # ESP32-C3: 3 Relés (Active-High) + DHT22 + LCD 20x4
│       └── Regulador_de_Temperatura.ino # Histerese térmica + Fotoperíodo + Web Server local
│
└── 📚 docs/                    # Documentações Técnicas e Manuais de Instalação
    ├── GUIA_CENTRAL_AGROCLIMATICA.md
    ├── GUIA_CONEXAO_ESP32.md
    ├── GUIA_SERVIDOR.md
    └── DOCUMENTACAO_COMPLETA.md
```

---

## 🔄 Como Atualizar o Servidor Linux de Casa

Sempre que fizer alterações no seu PC e der `git push`, acesse o servidor de casa e execute:

```bash
git pull && docker compose up -d --build
```
