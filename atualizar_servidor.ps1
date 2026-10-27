# ==============================================================================
# SCRIPT DE SINCRONIZAÇÃO E DEPLOY AUTOMÁTICO - MONTEBOT & SERVIDOR STI
# ==============================================================================
Write-Host "Iniciando verificacao de conexao com o Servidor STI..." -ForegroundColor Cyan

$IP_LOCAL = "192.168.0.105"
$IP_REMOTO = "100.126.236.22"
$USER = "leo"

# 1. Testa se esta na rede local de casa com ping rapido (800ms)
$pingLocal = (ping -n 1 -w 800 $IP_LOCAL) -match "TTL="

if ($pingLocal) {
    $TARGET_IP = $IP_LOCAL
    Write-Host "[CONEXAO] Conectando via Rede Local Wi-Fi ($TARGET_IP)..." -ForegroundColor Green
} else {
    $TARGET_IP = $IP_REMOTO
    Write-Host "[CONEXAO] Conectando via Tailscale Remoto ($TARGET_IP)..." -ForegroundColor Yellow
}

$BASE_DIR = "C:\Users\Leonardo\OneDrive\Documentos\Servidor STI"

Write-Host "`n[1/3] Enviando novo Frontend (index.html) e Backend (server.js)..." -ForegroundColor Cyan
scp "$BASE_DIR\apps\ponto\public\index.html" "$USER@${TARGET_IP}:/home/leo/server/apps/ponto/public/index.html"
scp "$BASE_DIR\apps\ponto\server.js" "$USER@${TARGET_IP}:/home/leo/server/apps/ponto/server.js"

Write-Host "`n[2/3] Reiniciando container ponto-server no Linux Mint..." -ForegroundColor Cyan
ssh "$USER@$TARGET_IP" "docker restart ponto-server"

# Opcional: Atualizar Vigil Agent se existir o arquivo
$VIGIL_FILE = "C:\Users\Leonardo\OneDrive\Documentos\VS Code\Sistema Vigil\server\server_agent.py"
if (Test-Path $VIGIL_FILE) {
    Write-Host "`n[3/3] Atualizando Sistema Vigil (Porta 5000)..." -ForegroundColor Cyan
    scp $VIGIL_FILE "$USER@${TARGET_IP}:/opt/vigil/server_agent.py"
    ssh "$USER@$TARGET_IP" "sudo systemctl restart vigil-agent"
}

Write-Host "`n========================================================" -ForegroundColor Green
Write-Host " Deploy Concluido com Sucesso!" -ForegroundColor Green
Write-Host " Acesse pelo Navegador:" -ForegroundColor White
Write-Host " -> Local:   http://${TARGET_IP}:3002" -ForegroundColor Cyan
Write-Host " -> Publico: https://blackberry-pleasant-equivalent-league.trycloudflare.com" -ForegroundColor Cyan
Write-Host "========================================================`n" -ForegroundColor Green
