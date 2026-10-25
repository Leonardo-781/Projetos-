# 🖥️ Guia do Servidor Doméstico (Linux Mint) & Projeto GAIA / ATGH2O

Este documento centraliza todas as informações de acesso, arquitetura, credenciais e comandos úteis para o seu servidor.

---

## 📌 1. Informações de Conexão e Rede

| Parâmetro | Valor |
| :--- | :--- |
| **Sistema Operacional** | Linux Mint 22.3 (Base Ubuntu 24.04 LTS) |
| **IP Local (Rede de Casa)** | `192.168.0.105` |
| **IP Tailscale (Remoto / VPN)** | `100.126.236.22` |
| **Nome da Máquina no Tailscale** | `server1` |
| **Usuário SSH** | `leo` |
| **Autenticação SSH** | Chave pública configurada (login direto sem senha pelo seu PC) |
| **Permissões Sudo** | Habilitado sem solicitação de senha (`NOPASSWD`) |
| **Comportamento da Tampa** | Configurado para **ignorar** fechamento (não suspende nem desliga) |

---

## 🌍 2. Acesso Público Mundial (Cloudflare Tunnel)

Para que qualquer pessoa acerte o sistema de qualquer lugar (inclusive da rede bloqueada da Universidade Federal):

* **Link Público Mundial:**  
  👉 **[https://reviews-responsible-approval-beautiful.trycloudflare.com](https://reviews-responsible-approval-beautiful.trycloudflare.com)**
* **Certificado SSL / HTTPS:** Automático, emitido e protegido pela Cloudflare.
* **Serviço no Linux Mint:** Rodando 24/7 gerenciado pelo `systemd` (`gaia-tunnel.service`).

---

## 🗺️ 3. Sistema Web em React: Mapa Geoespacial em Tela Cheia

A aplicação foi reconstruída em **React + Vite + Tailwind CSS + Leaflet**, seguindo fielmente a interface da **ATGH2O**:
* **Home Page 100% Mapa Satélite:** Visão em tela cheia com imagens de satélite de alta definição da região agrícola (Monte Carmelo, Arraial Perdizes, Santa Bárbara, São Félix, etc.).
* **Pinos Estilo ATGH2O:** Marcadores em gota azul/ciano com ícones meteorológicos e ponto de status no canto superior direito:
  * 🟢 **Verde:** Estação Online (&lt; 6 min).
  * 🟡 **Amarelo:** Estação em *Deep Sleep* (6 a 15 min).
  * 🔴 **Vermelho:** Estação Offline (&gt; 15 min).
* **Botão Flutuante de Filtros:** No canto superior esquerdo, permitindo filtrar por status e alternar entre Satélite Real e Modo Noturno.
* **Drawer Lateral de Telemetria:** Ao clicar em qualquer estação no mapa, abre um painel lateral deslizante com métricas ao vivo, status do VPD, Evapotranspiração ($ET_0$), gráficos dinâmicos e botão de teste.

---

## 🚀 4. Serviços Ativos e Painéis Web

Todos os serviços rodam em containers **Docker** isolados, orquestrados pelo arquivo `/home/leo/server/docker-compose.yml`.

| Serviço | Acesso Local | Acesso Tailscale | Acesso Público (Mundial) | Notas / Credenciais |
| **ATGH2O / GAIA** (React + API) | `http://192.168.0.105:3000` | `http://100.126.236.22:3000` | [Link Cloudflare](https://reviews-responsible-approval-beautiful.trycloudflare.com) | Sistema completo com Mapa Satélite e Telemetria.<br>**Usuário:** `usuario@gaia.agro.br` (Senha: `GaiaUser2026!`)<br>**Admin:** `admin@gaia.agro.br` (Senha: `GaiaAdmin2026!`) |
| **Portainer** (Gestão Docker) | `http://192.168.0.105:9000` | `http://100.126.236.22:9000` | -- | Painel gráfico para gerenciar containers |
| **Nginx Proxy Manager** (SSL/Proxy) | `http://192.168.0.105:81` | `http://100.126.236.22:81` | -- | **Email:** `admin@example.com`<br>**Senha:** `changeme` |
| **Adminer** (Visualizador Web BD) | `http://192.168.0.105:8080` | `http://100.126.236.22:8080` | -- | Sistema: PostgreSQL<br>Servidor: `postgres`<br>Usuário: `server_admin`<br>Senha: `server_password_123`<br>Banco: `app_db` |
| **PostgreSQL 16** | Porta `5432` | Porta `5432` | -- | Tabelas: `gaia_telemetria` e `gaia_estacoes` |
| **Mosquitto MQTT** | Portas `1883` e `9001` | Portas `1883` e `9001` | -- | Broker para mensagens IoT/ESP32 |

---

## 📡 5. Como Configurar o ESP32 para Enviar Dados

No código do ESP32 (`TX Telemetria.c`), configure o endpoint:

### Em rede local (Wi-Fi de casa):
```cpp
#define DEFAULT_SERVER_URL "http://192.168.0.105:3000/api/telemetria"
```

### No campo / Internet (Wi-Fi externo ou 4G):
```cpp
#define DEFAULT_SERVER_URL "https://reviews-responsible-approval-beautiful.trycloudflare.com/api/telemetria"
```
