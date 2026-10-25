const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'AgroClimaSecretTokenKey2026!#%';

// Configuração do PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://server_admin:server_password_123@postgres:5432/app_db'
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// =========================================================================
// FUNÇÕES DE CRIPTOGRAFIA & AUTENTICAÇÃO (JWT & HASH)
// =========================================================================
function hashPassword(password, salt = null) {
  if (!salt) {
    salt = crypto.randomBytes(16).toString('hex');
  }
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const check = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return check === hash;
}

function generateJWT(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + (30 * 24 * 3600) })).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${fullPayload}`).digest('base64url');
  return `${header}.${fullPayload}.${signature}`;
}

function verifyJWT(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  if (signature !== expectedSig) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.exp && data.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return data;
  } catch (e) {
    return null;
  }
}

// Middleware de autorização para controle dos relés
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ 
      error: 'Acesso restrito. Faça login para acionar ou controlar os relés.' 
    });
  }

  const user = verifyJWT(token);
  if (!user) {
    return res.status(403).json({ 
      error: 'Sessão expirada ou credenciais inválidas. Faça login novamente.' 
    });
  }

  req.user = user;
  next();
}

// Inicialização e verificação do Banco de Dados
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agroclima_leituras (
          id SERIAL PRIMARY KEY,
          sistema VARCHAR(30) NOT NULL,
          temperatura NUMERIC(5, 2) NOT NULL,
          umidade NUMERIC(5, 2) NOT NULL,
          criado_em TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_agroclima_leituras_sistema_tempo 
      ON agroclima_leituras (sistema, criado_em DESC);

      CREATE TABLE IF NOT EXISTS agroclima_eventos_reles (
          id SERIAL PRIMARY KEY,
          sistema VARCHAR(30) NOT NULL,
          rele VARCHAR(50) NOT NULL,
          estado VARCHAR(20) NOT NULL,
          modo VARCHAR(20) NOT NULL,
          motivo TEXT,
          temperatura NUMERIC(5, 2),
          umidade NUMERIC(5, 2),
          criado_em TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_agroclima_eventos_sistema_tempo 
      ON agroclima_eventos_reles (sistema, criado_em DESC);

      CREATE TABLE IF NOT EXISTS agroclima_status_atual (
          sistema VARCHAR(30) PRIMARY KEY,
          temperatura NUMERIC(5, 2),
          umidade NUMERIC(5, 2),
          reles_estado JSONB DEFAULT '{}'::jsonb,
          reles_modo JSONB DEFAULT '{}'::jsonb,
          sistema_ativo BOOLEAN DEFAULT TRUE,
          comandos_pendentes JSONB DEFAULT '[]'::jsonb,
          ultimo_ping TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          ip_local VARCHAR(45),
          sinal_wifi INTEGER
      );

      CREATE TABLE IF NOT EXISTS agroclima_usuarios (
          id SERIAL PRIMARY KEY,
          nome VARCHAR(100) NOT NULL,
          email VARCHAR(150) UNIQUE NOT NULL,
          senha_hash VARCHAR(255) NOT NULL,
          salt VARCHAR(64) NOT NULL,
          role VARCHAR(30) DEFAULT 'admin',
          criado_em TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS agroclima_configuracoes (
          sistema VARCHAR(32) PRIMARY KEY,
          temp_min NUMERIC(4, 1) NOT NULL DEFAULT 26.0,
          temp_max NUMERIC(4, 1) NOT NULL DEFAULT 28.0,
          pos_ventilacao_min INTEGER NOT NULL DEFAULT 5,
          atualizado_em TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          atualizado_por VARCHAR(100) DEFAULT 'Sistema'
      );

      INSERT INTO agroclima_configuracoes (sistema, temp_min, temp_max, pos_ventilacao_min, atualizado_por)
      VALUES 
        ('regulador', 26.0, 28.0, 5, 'Padrao'),
        ('estufa', 22.0, 28.0, 0, 'Padrao')
      ON CONFLICT (sistema) DO NOTHING;
    `);

    // Cria usuário administrador padrão caso não exista
    const userCount = await pool.query('SELECT count(*) FROM agroclima_usuarios');
    if (parseInt(userCount.rows[0].count) === 0) {
      const { hash, salt } = hashPassword('admin123');
      await pool.query(`
        INSERT INTO agroclima_usuarios (nome, email, senha_hash, salt, role)
        VALUES ($1, $2, $3, $4, $5)
      `, ['Administrador', 'admin@agroclima.com', hash, salt, 'admin']);
      console.log('[AUTH] Conta de administrador inicial criada: admin@agroclima.com / admin123');
    }

    console.log('[DB] Tabelas do sistema Agroclima inicializadas com sucesso.');
  } catch (err) {
    console.error('[DB] Erro ao inicializar banco de dados:', err.message);
  }
}
initDb();

// =========================================================================
// ROTAS DE AUTENTICAÇÃO
// =========================================================================

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) {
      return res.status(400).json({ error: 'Informe email e senha.' });
    }

    const userRes = await pool.query(
      'SELECT id, nome, email, senha_hash, salt, role FROM agroclima_usuarios WHERE LOWER(email) = LOWER($1)',
      [email.trim()]
    );

    if (userRes.rows.length === 0) {
      return res.status(401).json({ error: 'Credenciais inválidas. Verifique o email ou senha.' });
    }

    const user = userRes.rows[0];
    if (!verifyPassword(senha, user.senha_hash, user.salt)) {
      return res.status(401).json({ error: 'Credenciais inválidas. Verifique o email ou senha.' });
    }

    const token = generateJWT({
      id: user.id,
      nome: user.nome,
      email: user.email,
      role: user.role
    });

    console.log(`[AUTH LOGIN] Usuário autenticado: ${user.nome} (${user.email}) - Permissão: ${user.role}`);

    return res.json({
      status: 'ok',
      token,
      usuario: {
        id: user.id,
        nome: user.nome,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    console.error('[AUTH LOGIN ERRO]', err);
    return res.status(500).json({ error: 'Erro interno ao realizar autenticação.' });
  }
});

// Verificar sessão atual
app.get('/api/auth/me', authenticateToken, (req, res) => {
  return res.json({ status: 'ok', usuario: req.user });
});

// =========================================================================
// ROTAS DE TELEMETRIA E CONTROLE DOS ESP32
// =========================================================================

// 1. Receber telemetria do ESP32 (Estufa ou Regulador)
// Registra no banco histórico a cada 15 minutos e devolve comandos pendentes
app.post('/api/telemetria', async (req, res) => {
  try {
    const {
      sistema, // 'estufa' ou 'regulador'
      temperatura,
      umidade,
      reles_estado,
      reles_modo,
      ip_local,
      sinal_wifi
    } = req.body;

    if (!sistema || temperatura === undefined || umidade === undefined) {
      return res.status(400).json({ error: 'Campos obrigatorios ausentes (sistema, temperatura, umidade)' });
    }

    const tempNum = parseFloat(temperatura);
    const umiNum = parseFloat(umidade);

    // 1. Atualiza o status atual e recupera comandos pendentes e flag sistema_ativo
    const statusQuery = `
      INSERT INTO agroclima_status_atual (
        sistema, temperatura, umidade, reles_estado, reles_modo, 
        ultimo_ping, ip_local, sinal_wifi
      )
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, $6, $7)
      ON CONFLICT (sistema) DO UPDATE SET
        temperatura = EXCLUDED.temperatura,
        umidade = EXCLUDED.umidade,
        reles_estado = COALESCE(EXCLUDED.reles_estado, agroclima_status_atual.reles_estado),
        reles_modo = COALESCE(EXCLUDED.reles_modo, agroclima_status_atual.reles_modo),
        ultimo_ping = CURRENT_TIMESTAMP,
        ip_local = COALESCE(EXCLUDED.ip_local, agroclima_status_atual.ip_local),
        sinal_wifi = COALESCE(EXCLUDED.sinal_wifi, agroclima_status_atual.sinal_wifi)
      RETURNING sistema_ativo, comandos_pendentes;
    `;

    const statusRes = await pool.query(statusQuery, [
      sistema,
      tempNum,
      umiNum,
      JSON.stringify(reles_estado || {}),
      JSON.stringify(reles_modo || {}),
      ip_local || null,
      sinal_wifi !== undefined ? parseInt(sinal_wifi) : null
    ]);

    const row = statusRes.rows[0];
    const sistemaAtivo = row ? row.sistema_ativo : true;
    let comandosParaEnviar = (row && row.comandos_pendentes) ? row.comandos_pendentes : [];

    // Limpa a fila de comandos pendentes após entregar ao ESP32
    if (comandosParaEnviar.length > 0) {
      await pool.query(
        `UPDATE agroclima_status_atual SET comandos_pendentes = '[]'::jsonb WHERE sistema = $1`,
        [sistema]
      );
    }

    // 2. REGISTRO HISTÓRICO DE 15 MINUTOS
    const checkLeitura = await pool.query(`
      SELECT criado_em FROM agroclima_leituras 
      WHERE sistema = $1 
      ORDER BY criado_em DESC 
      LIMIT 1
    `, [sistema]);

    let gravarLeitura = false;
    if (checkLeitura.rows.length === 0) {
      gravarLeitura = true;
    } else {
      const ultimaLeitura = new Date(checkLeitura.rows[0].criado_em).getTime();
      const agora = Date.now();
      const diferencaMinutos = (agora - ultimaLeitura) / (1000 * 60);
      if (diferencaMinutos >= 15) {
        gravarLeitura = true;
      }
    }

    if (gravarLeitura) {
      await pool.query(`
        INSERT INTO agroclima_leituras (sistema, temperatura, umidade)
        VALUES ($1, $2, $3)
      `, [sistema, tempNum, umiNum]);
      console.log(`[HISTORICO 15 MIN] Gravada leitura para ${sistema}: ${tempNum}°C, ${umiNum}%`);
    }

    // 3. RECUPERA SETPOINTS CONFIGURADOS PARA SINCRONIZAR COM O ESP32
    const cfgRes = await pool.query(`
      SELECT temp_min, temp_max, pos_ventilacao_min 
      FROM agroclima_configuracoes 
      WHERE sistema = $1
    `, [sistema]);
    const setpoints = cfgRes.rows[0] ? {
      temp_min: parseFloat(cfgRes.rows[0].temp_min),
      temp_max: parseFloat(cfgRes.rows[0].temp_max),
      pos_ventilacao_min: parseInt(cfgRes.rows[0].pos_ventilacao_min)
    } : (sistema === 'regulador' ? { temp_min: 26.0, temp_max: 28.0, pos_ventilacao_min: 5 } : { temp_min: 22.0, temp_max: 28.0, pos_ventilacao_min: 0 });

    return res.json({
      status: 'ok',
      sistema_ativo: sistemaAtivo,
      comandos: comandosParaEnviar,
      setpoints
    });
  } catch (err) {
    console.error('[TELEMETRIA] Erro ao processar:', err);
    return res.status(500).json({ error: 'Erro interno ao processar telemetria' });
  }
});

// 2. Registrar evento imediato de relé (Acionamento ou Desligamento)
app.post('/api/evento-rele', async (req, res) => {
  try {
    const {
      sistema,
      rele,
      estado,
      modo,
      motivo,
      temperatura,
      umidade
    } = req.body;

    if (!sistema || !rele || !estado) {
      return res.status(400).json({ error: 'Campos obrigatorios: sistema, rele, estado' });
    }

    const tempNum = temperatura !== undefined ? parseFloat(temperatura) : null;
    const umiNum = umidade !== undefined ? parseFloat(umidade) : null;

    // Salva o evento na tabela de logs
    await pool.query(`
      INSERT INTO agroclima_eventos_reles (
        sistema, rele, estado, modo, motivo, temperatura, umidade
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      sistema,
      rele,
      estado.toUpperCase(),
      (modo || 'AUTOMATICO').toUpperCase(),
      motivo || 'Comutação de estado do relé',
      tempNum,
      umiNum
    ]);

    // Atualiza o estado do relé no status atual
    const booleanEstado = estado.toUpperCase() === 'LIGADO';
    await pool.query(`
      UPDATE agroclima_status_atual
      SET reles_estado = jsonb_set(COALESCE(reles_estado, '{}'::jsonb), ARRAY[$2], $3::jsonb)
      WHERE sistema = $1
    `, [sistema, rele, JSON.stringify(booleanEstado)]);

    console.log(`[EVENTO RELE] ${sistema.toUpperCase()} -> ${rele}: ${estado} (${modo}) - Motivo: ${motivo}`);

    return res.json({ status: 'ok', message: 'Evento de relé registrado com sucesso' });
  } catch (err) {
    console.error('[EVENTO RELE] Erro ao registrar:', err);
    return res.status(500).json({ error: 'Erro interno ao salvar evento' });
  }
});

// =========================================================================
// ROTAS PARA O PAINEL WEB (DASHBOARD)
// =========================================================================

// 3. Status atual de ambos os sistemas (Público para visualização)
app.get('/api/status', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        sistema, 
        temperatura, 
        umidade, 
        reles_estado, 
        reles_modo, 
        sistema_ativo, 
        ultimo_ping, 
        ip_local, 
        sinal_wifi,
        CASE 
          WHEN ultimo_ping >= (CURRENT_TIMESTAMP - INTERVAL '60 seconds') THEN true 
          ELSE false 
        END AS online
      FROM agroclima_status_atual
    `);

    const cfgResult = await pool.query(`
      SELECT sistema, temp_min, temp_max, pos_ventilacao_min, atualizado_em, atualizado_por 
      FROM agroclima_configuracoes
    `);
    const configs = {};
    cfgResult.rows.forEach(c => {
      configs[c.sistema] = {
        temp_min: parseFloat(c.temp_min),
        temp_max: parseFloat(c.temp_max),
        pos_ventilacao_min: parseInt(c.pos_ventilacao_min),
        atualizado_em: c.atualizado_em,
        atualizado_por: c.atualizado_por
      };
    });

    const data = {
      estufa: configs.estufa ? { setpoints: configs.estufa } : null,
      regulador: configs.regulador ? { setpoints: configs.regulador } : null
    };

    result.rows.forEach(r => {
      data[r.sistema] = {
        ...r,
        setpoints: configs[r.sistema] || null
      };
    });

    return res.json(data);
  } catch (err) {
    console.error('[STATUS] Erro:', err);
    return res.status(500).json({ error: 'Erro ao consultar status' });
  }
});

// 3.1 Consultar setpoints de um sistema (Público)
app.get('/api/setpoints/:sistema', async (req, res) => {
  try {
    const { sistema } = req.params;
    const result = await pool.query(`
      SELECT sistema, temp_min, temp_max, pos_ventilacao_min, atualizado_em, atualizado_por
      FROM agroclima_configuracoes
      WHERE sistema = $1
    `, [sistema]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Configurações não encontradas para este sistema' });
    }

    const row = result.rows[0];
    return res.json({
      status: 'ok',
      sistema: row.sistema,
      temp_min: parseFloat(row.temp_min),
      temp_max: parseFloat(row.temp_max),
      pos_ventilacao_min: parseInt(row.pos_ventilacao_min),
      atualizado_em: row.atualizado_em,
      atualizado_por: row.atualizado_por
    });
  } catch (err) {
    console.error('[SETPOINTS GET] Erro:', err);
    return res.status(500).json({ error: 'Erro ao consultar setpoints' });
  }
});

// 3.2 Alterar setpoints de um sistema - PROTEGIDO COM AUTENTICAÇÃO JWT
app.post('/api/setpoints', authenticateToken, async (req, res) => {
  try {
    const { sistema, temp_min, temp_max, pos_ventilacao_min } = req.body;

    if (!sistema) {
      return res.status(400).json({ error: 'Campo sistema obrigatório' });
    }

    const tMin = parseFloat(temp_min);
    const tMax = parseFloat(temp_max);
    const posVent = parseInt(pos_ventilacao_min !== undefined ? pos_ventilacao_min : 5);

    if (isNaN(tMin) || isNaN(tMax)) {
      return res.status(400).json({ error: 'Valores de temperatura inválidos' });
    }

    if (tMin < 10.0 || tMin > 45.0 || tMax < 12.0 || tMax > 50.0) {
      return res.status(400).json({ error: 'Temperatura fora dos limites permitidos (10°C a 50°C)' });
    }

    if (tMin >= tMax) {
      return res.status(400).json({ error: 'Temperatura mínima deve ser estritamente menor que a máxima' });
    }

    if (posVent < 0 || posVent > 60) {
      return res.status(400).json({ error: 'Tempo de pós-ventilação deve estar entre 0 e 60 minutos' });
    }

    const operadorInfo = req.user ? `${req.user.nome} (${req.user.role})` : 'Usuário Autenticado';

    await pool.query(`
      INSERT INTO agroclima_configuracoes (sistema, temp_min, temp_max, pos_ventilacao_min, atualizado_em, atualizado_por)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, $5)
      ON CONFLICT (sistema) DO UPDATE SET
        temp_min = EXCLUDED.temp_min,
        temp_max = EXCLUDED.temp_max,
        pos_ventilacao_min = EXCLUDED.pos_ventilacao_min,
        atualizado_em = CURRENT_TIMESTAMP,
        atualizado_por = EXCLUDED.atualizado_por
    `, [sistema, tMin, tMax, posVent, operadorInfo]);

    // Registra evento de auditoria
    const motivoLog = `Setpoints ajustados: Min: ${tMin}°C, Max: ${tMax}°C, Pós-Vent: ${posVent} min por ${operadorInfo}`;
    await pool.query(`
      INSERT INTO agroclima_eventos_reles (sistema, rele, estado, modo, motivo)
      VALUES ($1, 'setpoints', 'CONFIGURADO', 'MANUAL', $2)
    `, [sistema, motivoLog]);

    console.log(`[SETPOINTS] ${sistema.toUpperCase()} atualizado por ${operadorInfo}: Min ${tMin}°C, Max ${tMax}°C, Pós-Vent ${posVent}min`);

    // DISPARO IMEDIATO AO ESP32 (Sub-segundo se na mesma rede Wi-Fi/LAN)
    try {
      const rowRes = await pool.query('SELECT ip_local FROM agroclima_status_atual WHERE sistema = $1', [sistema]);
      const espIp = rowRes.rows[0]?.ip_local;
      if (espIp && espIp !== 'Desconhecido' && espIp !== '--') {
        fetch(`http://${espIp}/api/setpoints`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ temp_min: tMin, temp_max: tMax, pos_ventilacao_min: posVent }),
          signal: AbortSignal.timeout(1200)
        }).catch(() => {});
      }
    } catch (e) {}

    return res.json({
      status: 'ok',
      message: 'Parâmetros térmicos atualizados com sucesso',
      config: {
        sistema,
        temp_min: tMin,
        temp_max: tMax,
        pos_ventilacao_min: posVent,
        atualizado_por: operadorInfo
      }
    });
  } catch (err) {
    console.error('[SETPOINTS POST] Erro:', err);
    return res.status(500).json({ error: 'Erro ao salvar setpoints' });
  }
});

// 4. Enviar comando manual para um relé (Auto / On / Off) - PROTEGIDO COM AUTENTICAÇÃO
app.post('/api/comando', authenticateToken, async (req, res) => {
  try {
    const { sistema, rele, action } = req.body;

    if (!sistema || !rele || !action) {
      return res.status(400).json({ error: 'Parametros sistema, rele e action obrigatorios' });
    }

    const validActions = ['auto', 'on', 'off'];
    if (!validActions.includes(action.toLowerCase())) {
      return res.status(400).json({ error: 'Action deve ser auto, on ou off' });
    }

    const act = action.toLowerCase();
    const cmdItem = { rele, action: act };

    if (act === 'on' || act === 'off') {
      const isLigado = (act === 'on');
      await pool.query(`
        UPDATE agroclima_status_atual
        SET 
          comandos_pendentes = COALESCE(comandos_pendentes, '[]'::jsonb) || $2::jsonb,
          reles_modo = jsonb_set(COALESCE(reles_modo, '{}'::jsonb), ARRAY[$3], $4::jsonb),
          reles_estado = jsonb_set(COALESCE(reles_estado, '{}'::jsonb), ARRAY[$3], $5::jsonb)
        WHERE sistema = $1
      `, [
        sistema, 
        JSON.stringify([cmdItem]), 
        rele, 
        JSON.stringify('manual'),
        JSON.stringify(isLigado)
      ]);

      const estadoStr = act === 'on' ? 'LIGADO' : 'DESLIGADO';
      const operadorInfo = req.user ? `${req.user.nome} (${req.user.role})` : 'Usuário Autenticado';
      await pool.query(`
        INSERT INTO agroclima_eventos_reles (sistema, rele, estado, modo, motivo)
        VALUES ($1, $2, $3, 'MANUAL', $4)
      `, [sistema, rele, estadoStr, `Comando manual por ${operadorInfo} via painel web`]);
    } else {
      await pool.query(`
        UPDATE agroclima_status_atual
        SET 
          comandos_pendentes = COALESCE(comandos_pendentes, '[]'::jsonb) || $2::jsonb,
          reles_modo = jsonb_set(COALESCE(reles_modo, '{}'::jsonb), ARRAY[$3], $4::jsonb)
        WHERE sistema = $1
      `, [
        sistema, 
        JSON.stringify([cmdItem]), 
        rele, 
        JSON.stringify('auto')
      ]);
    }

    // DISPARO IMEDIATO AO ESP32 (Sub-segundo se na mesma rede Wi-Fi/LAN)
    try {
      const rowRes = await pool.query('SELECT ip_local FROM agroclima_status_atual WHERE sistema = $1', [sistema]);
      const espIp = rowRes.rows[0]?.ip_local;
      if (espIp && espIp !== 'Desconhecido' && espIp !== '--') {
        fetch(`http://${espIp}/api/comando`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rele, action: act }),
          signal: AbortSignal.timeout(1200)
        }).catch(() => {});
      }
    } catch (e) {}

    return res.json({ 
      status: 'ok', 
      message: `Comando ${action} enviado para ${rele} por ${req.user.nome}` 
    });
  } catch (err) {
    console.error('[COMANDO] Erro:', err);
    return res.status(500).json({ error: 'Erro ao registrar comando' });
  }
});

// 5. PARADA GERAL / ATIVAR OU DESATIVAR TODO O SISTEMA - PROTEGIDO COM AUTENTICAÇÃO
app.post('/api/sistema/toggle', authenticateToken, async (req, res) => {
  try {
    const { sistema, ativo } = req.body;

    if (!sistema || ativo === undefined) {
      return res.status(400).json({ error: 'Campos sistema e ativo obrigatorios' });
    }

    const novoAtivo = Boolean(ativo);
    const operadorInfo = req.user ? `${req.user.nome} (${req.user.role})` : 'Usuário Autenticado';

    let relesAfetados = [];
    if (sistema === 'estufa') {
      relesAfetados = ['rele_principal'];
    } else if (sistema === 'regulador') {
      relesAfetados = ['aquecedor', 'cooler', 'led'];
    }

    let comandos = [];
    if (!novoAtivo) {
      comandos = relesAfetados.map(r => ({ rele: r, action: 'off' }));

      for (const r of relesAfetados) {
        await pool.query(`
          INSERT INTO agroclima_eventos_reles (sistema, rele, estado, modo, motivo)
          VALUES ($1, $2, 'DESLIGADO', 'MANUAL', $3)
        `, [sistema, r, `PARADA GERAL ATIVADA por ${operadorInfo}`]);
      }
    } else {
      comandos = relesAfetados.map(r => ({ rele: r, action: 'auto' }));

      for (const r of relesAfetados) {
        await pool.query(`
          INSERT INTO agroclima_eventos_reles (sistema, rele, estado, modo, motivo)
          VALUES ($1, $2, 'DESLIGADO', 'AUTOMATICO', $3)
        `, [sistema, r, `SISTEMA REATIVADO por ${operadorInfo}`]);
      }
    }

    await pool.query(`
      UPDATE agroclima_status_atual
      SET 
        sistema_ativo = $2,
        comandos_pendentes = COALESCE(comandos_pendentes, '[]'::jsonb) || $3::jsonb
      WHERE sistema = $1
    `, [sistema, novoAtivo, JSON.stringify(comandos)]);

    console.log(`[SISTEMA TOGGLE] ${sistema} -> Ativo: ${novoAtivo} por ${operadorInfo}`);

    // DISPARO IMEDIATO AO ESP32 PARA PARADA GERAL
    try {
      const rowRes = await pool.query('SELECT ip_local FROM agroclima_status_atual WHERE sistema = $1', [sistema]);
      const espIp = rowRes.rows[0]?.ip_local;
      if (espIp && espIp !== 'Desconhecido' && espIp !== '--') {
        fetch(`http://${espIp}/api/sistema/toggle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sistema_ativo: novoAtivo }),
          signal: AbortSignal.timeout(1200)
        }).catch(() => {});
      }
    } catch (e) {}

    return res.json({ 
      status: 'ok', 
      sistema, 
      sistema_ativo: novoAtivo,
      operador: req.user.nome,
      message: novoAtivo ? 'Sistema reativado com sucesso' : 'Sistema desativado com sucesso (Parada Geral)'
    });
  } catch (err) {
    console.error('[SISTEMA TOGGLE] Erro:', err);
    return res.status(500).json({ error: 'Erro ao alternar status geral do sistema' });
  }
});

// 6. Consultar histórico de leituras de 15 minutos (para gráficos) - Público para visualização
app.get('/api/historico/:sistema', async (req, res) => {
  try {
    const { sistema } = req.params;
    const { periodo } = req.query;

    let intervalClause = "criado_em >= (NOW() - INTERVAL '24 hours')";
    if (periodo === '1h') {
      intervalClause = "criado_em >= (NOW() - INTERVAL '1 hour')";
    } else if (periodo === '6h') {
      intervalClause = "criado_em >= (NOW() - INTERVAL '6 hours')";
    } else if (periodo === '7d') {
      intervalClause = "criado_em >= (NOW() - INTERVAL '7 days')";
    } else if (periodo === '30d') {
      intervalClause = "criado_em >= (NOW() - INTERVAL '30 days')";
    } else if (periodo === 'all') {
      intervalClause = "1=1";
    }

    const query = `
      SELECT id, sistema, temperatura, umidade, criado_em
      FROM agroclima_leituras
      WHERE sistema = $1 AND ${intervalClause}
      ORDER BY criado_em ASC
    `;

    const result = await pool.query(query, [sistema]);
    return res.json(result.rows);
  } catch (err) {
    console.error('[HISTORICO] Erro:', err);
    return res.status(500).json({ error: 'Erro ao buscar leituras historicas' });
  }
});

// Rota de Simulação / Injeção de Dados de Teste
app.post('/api/simular', async (req, res) => {
  try {
    const { sistema, temperatura, umidade } = req.body;
    const sys = sistema || 'regulador';
    const temp = parseFloat(temperatura) || (sys === 'regulador' ? 26.8 : 25.2);
    const umi = parseFloat(umidade) || 58.0;

    await pool.query(`
      INSERT INTO agroclima_leituras (sistema, temperatura, umidade)
      VALUES ($1, $2, $3)
    `, [sys, temp, umi]);

    await pool.query(`
      UPDATE agroclima_status_atual
      SET temperatura = $2, umidade = $3, ultimo_ping = CURRENT_TIMESTAMP
      WHERE sistema = $1
    `, [sys, temp, umi]);

    return res.json({ status: 'ok', message: `Dados simulados inseridos para ${sys}: ${temp}°C, ${umi}%` });
  } catch (err) {
    console.error('[SIMULACAO] Erro:', err);
    return res.status(500).json({ error: 'Erro ao simular dados' });
  }
});

// 7. Consultar histórico de eventos dos relés - Público para visualização
app.get('/api/logs/:sistema', async (req, res) => {
  try {
    const { sistema } = req.params;
    const limit = parseInt(req.query.limit) || 100;

    let query = `
      SELECT id, sistema, rele, estado, modo, motivo, temperatura, umidade, criado_em
      FROM agroclima_eventos_reles
    `;
    const params = [];

    if (sistema && sistema !== 'all') {
      query += ` WHERE sistema = $1`;
      params.push(sistema);
      query += ` ORDER BY criado_em DESC LIMIT $2`;
      params.push(limit);
    } else {
      query += ` ORDER BY criado_em DESC LIMIT $1`;
      params.push(limit);
    }

    const result = await pool.query(query, params);
    return res.json(result.rows);
  } catch (err) {
    console.error('[LOGS] Erro:', err);
    return res.status(500).json({ error: 'Erro ao buscar logs de relés' });
  }
});

// 8. Exportar logs em formato CSV
app.get('/api/exportar-logs/:sistema', async (req, res) => {
  try {
    const { sistema } = req.params;

    let query = `
      SELECT id, sistema, rele, estado, modo, motivo, temperatura, umidade, criado_em
      FROM agroclima_eventos_reles
    `;
    const params = [];

    if (sistema && sistema !== 'all') {
      query += ` WHERE sistema = $1`;
      params.push(sistema);
    }
    query += ` ORDER BY criado_em DESC`;

    const result = await pool.query(query, params);

    let csv = 'ID,Data/Hora,Sistema,Rele,Estado,Modo,Temperatura,Umidade,Motivo\n';
    result.rows.forEach(r => {
      const dataHora = new Date(r.criado_em).toLocaleString('pt-BR');
      const motivoLimpo = (r.motivo || '').replace(/"/g, '""');
      csv += `${r.id},"${dataHora}","${r.sistema}","${r.rele}","${r.estado}","${r.modo}",${r.temperatura || ''},${r.umidade || ''},"${motivoLimpo}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=logs_reles_${sistema}_${Date.now()}.csv`);
    return res.send('\uFEFF' + csv);
  } catch (err) {
    console.error('[EXPORT CSV] Erro:', err);
    return res.status(500).send('Erro ao exportar CSV');
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[AGROCLIMA SERVER] Rodando na porta ${PORT} (0.0.0.0:${PORT})`);
});
