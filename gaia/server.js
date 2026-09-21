const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const PORT = process.env.PORT || 3000;
const AES_KEY = process.env.AES_KEY || 'GaiaAgroIoT2026!';
const LEGACY_AES_KEY = 'MARIACRYPTOKEY12';
const GAIA_PROJECT_TOKEN = process.env.GAIA_PROJECT_TOKEN || 'GAIA_TOKEN_2026_AGRO';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://server_admin:server_password_123@postgres:5432/app_db';
const JWT_SECRET = process.env.JWT_SECRET || 'GAIA_SUPER_SECRET_KEY_2026_JWT';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Pool de conexão com o PostgreSQL
const pool = new Pool({
  connectionString: DATABASE_URL,
});

// Inicialização e verificação de tabelas
async function initDatabase() {
  try {
    // 1. Tabela de Usuários
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gaia_usuarios (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        email VARCHAR(150) UNIQUE NOT NULL,
        senha_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) DEFAULT 'USER',
        criado_em TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Tabela de Telemetria
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gaia_telemetria (
        id SERIAL PRIMARY KEY,
        cod_estacao VARCHAR(16) NOT NULL,
        timestamp_utc BIGINT NOT NULL,
        data_hora TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        temp_bmp NUMERIC(5,2),
        pressao NUMERIC(7,2),
        lux NUMERIC(8,2),
        umidade NUMERIC(5,2),
        temp_dht NUMERIC(5,2),
        umidade_solo INT,
        temp_solo NUMERIC(5,2),
        temp_ref NUMERIC(5,2),
        delta_temp NUMERIC(5,2),
        qualidade INT,
        ponto_orvalho NUMERIC(5,2),
        vpd NUMERIC(6,3),
        et0 NUMERIC(6,4),
        etc NUMERIC(6,4),
        rs NUMERIC(7,2),
        par NUMERIC(7,2),
        rf INT DEFAULT 0,
        rg NUMERIC(6,2) DEFAULT 0,
        dp NUMERIC(5,2),
        at BOOLEAN DEFAULT FALSE,
        itu NUMERIC(5,2),
        hi NUMERIC(5,2),
        heap_mod INT,
        raw_payload JSONB
      );
      CREATE INDEX IF NOT EXISTS idx_gaia_estacao_ts ON gaia_telemetria (cod_estacao, timestamp_utc DESC);
    `);

    // Migração de colunas adicionais para bancos já existentes
    await pool.query(`
      ALTER TABLE gaia_telemetria ADD COLUMN IF NOT EXISTS etc NUMERIC(6,4);
      ALTER TABLE gaia_telemetria ADD COLUMN IF NOT EXISTS rs NUMERIC(7,2);
      ALTER TABLE gaia_telemetria ADD COLUMN IF NOT EXISTS par NUMERIC(7,2);
      ALTER TABLE gaia_telemetria ADD COLUMN IF NOT EXISTS rf INT DEFAULT 0;
      ALTER TABLE gaia_telemetria ADD COLUMN IF NOT EXISTS rg NUMERIC(6,2) DEFAULT 0;
      ALTER TABLE gaia_telemetria ADD COLUMN IF NOT EXISTS dp NUMERIC(5,2);
      ALTER TABLE gaia_telemetria ADD COLUMN IF NOT EXISTS at BOOLEAN DEFAULT FALSE;
      ALTER TABLE gaia_telemetria ADD COLUMN IF NOT EXISTS itu NUMERIC(5,2);
      ALTER TABLE gaia_telemetria ADD COLUMN IF NOT EXISTS hi NUMERIC(5,2);
    `);

    // 3. Tabela de Cadastro e Geolocalização das Estações com Regras de Visibilidade e Financeiro
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gaia_estacoes (
        cod_estacao VARCHAR(16) PRIMARY KEY,
        nome VARCHAR(64) NOT NULL,
        cultura VARCHAR(64) DEFAULT 'Agricultura Geral',
        latitude NUMERIC(10, 6) NOT NULL DEFAULT -18.7300,
        longitude NUMERIC(10, 6) NOT NULL DEFAULT -47.4980,
        visibilidade VARCHAR(20) DEFAULT 'PUBLICA',
        status_financeiro VARCHAR(20) DEFAULT 'ATIVO',
        proprietario_id INT REFERENCES gaia_usuarios(id) ON DELETE SET NULL,
        api_token VARCHAR(64) DEFAULT NULL,
        ativo BOOLEAN DEFAULT TRUE,
        criado_em TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        atualizado_em TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      ALTER TABLE gaia_estacoes ADD COLUMN IF NOT EXISTS api_token VARCHAR(64) DEFAULT NULL;
    `);

    // 4. Criação da Conta Master Solicitada
    const emailMaster = 'cardosoleonardo1327@gmail.com';
    const senhaMaster = 'swordfish';
    const hash = bcrypt.hashSync(senhaMaster, 10);

    const userCheck = await pool.query('SELECT * FROM gaia_usuarios WHERE email = $1', [emailMaster]);
    let masterUserId = null;
    if (userCheck.rows.length === 0) {
      const inserted = await pool.query(`
        INSERT INTO gaia_usuarios (nome, email, senha_hash, role)
        VALUES ($1, $2, $3, 'ADMIN')
        RETURNING id;
      `, ['Leonardo Cardoso (Master)', emailMaster, hash]);
      masterUserId = inserted.rows[0].id;
      console.log(`[AUTH] Conta Master criada com sucesso: ${emailMaster}`);
    } else {
      masterUserId = userCheck.rows[0].id;
      await pool.query(`
        UPDATE gaia_usuarios 
        SET senha_hash = $1, role = 'ADMIN' 
        WHERE email = $2
      `, [hash, emailMaster]);
      console.log(`[AUTH] Conta Master verificada/atualizada: ${emailMaster}`);
    }

    // 5. Seed das Estações nos Três Cenários de Negócio com Token Unificado do Projeto GAIA
    await pool.query(`
      INSERT INTO gaia_estacoes (cod_estacao, nome, cultura, latitude, longitude, visibilidade, status_financeiro, proprietario_id, api_token)
      VALUES 
        ('G00001', 'Pivô 01 - Monte Carmelo', 'Café Arábica', -18.726500, -47.498500, 'PUBLICA', 'ATIVO', NULL, 'GAIA_TOKEN_2026_AGRO'),
        ('G00002', 'Talhão 04 - Arraial Perdizes', 'Soja Safra', -18.732000, -47.455000, 'PUBLICA', 'ATIVO', NULL, 'GAIA_TOKEN_2026_AGRO'),
        ('G00003', 'Fazenda Particular Santa Bárbara', 'Milho Especial', -18.765000, -47.512000, 'PRIVADA', 'ATIVO', $1, 'GAIA_TOKEN_2026_AGRO'),
        ('G00004', 'Estufa Climatizada - São Félix', 'Tomate Grape', -18.708000, -47.525000, 'PRIVADA', 'ATIVO', $1, 'GAIA_TOKEN_2026_AGRO'),
        ('G00005', 'Setor Oeste - Fazenda Estrela', 'Pastagem Confinamento', -18.719000, -47.555000, 'PUBLICA', 'PENDENTE', NULL, 'GAIA_TOKEN_2026_AGRO'),
        ('G00006', 'Represa Central - Perdizes', 'Recursos Hídricos', -18.741000, -47.482000, 'PUBLICA', 'ATIVO', NULL, 'GAIA_TOKEN_2026_AGRO')
      ON CONFLICT (cod_estacao) DO UPDATE SET
        visibilidade = EXCLUDED.visibilidade,
        status_financeiro = EXCLUDED.status_financeiro,
        proprietario_id = EXCLUDED.proprietario_id,
        api_token = 'GAIA_TOKEN_2026_AGRO';
    `, [masterUserId]);

    console.log('Banco de dados PostgreSQL e permissões de estações inicializados com sucesso.');
  } catch (err) {
    console.error('Erro ao inicializar banco de dados:', err.message);
  }
}
initDatabase();

// Middleware de Autenticação Opcional (extrai usuário do token se existir)
function obterUsuarioOpcional(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
    } catch (e) {
      req.user = null;
    }
  } else {
    req.user = null;
  }
  next();
}

// Middleware de Autenticação Obrigatória
function exigirAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Acesso não autorizado. Faça login para continuar.' });
  }
  const token = authHeader.substring(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Sessão expirada ou token inválido. Faça login novamente.' });
  }
}

// ==========================================
// ROTAS DE AUTENTICAÇÃO SEGURA (AUTH)
// ==========================================

// Login de Usuário
app.post('/api/auth/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) {
    return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
  }

  try {
    const result = await pool.query('SELECT * FROM gaia_usuarios WHERE email = $1', [email.trim().toLowerCase()]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Credenciais inválidas. Verifique seu e-mail e senha.' });
    }

    const usuario = result.rows[0];
    const senhaValida = bcrypt.compareSync(senha, usuario.senha_hash);
    if (!senhaValida) {
      return res.status(401).json({ error: 'Credenciais inválidas. Verifique seu e-mail e senha.' });
    }

    // Gera token JWT assinado
    const payload = {
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      role: usuario.role
    };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      status: 'ok',
      token,
      user: payload
    });
  } catch (err) {
    console.error('Erro no login:', err);
    res.status(500).json({ error: 'Erro interno ao realizar login.' });
  }
});

// Cadastro de Novo Usuário
app.post('/api/auth/registrar', async (req, res) => {
  const { nome, email, senha } = req.body;
  if (!nome || !email || !senha) {
    return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios.' });
  }
  if (senha.length < 6) {
    return res.status(400).json({ error: 'A senha deve ter no mínimo 6 caracteres.' });
  }

  try {
    const emailFormatado = email.trim().toLowerCase();
    const check = await pool.query('SELECT id FROM gaia_usuarios WHERE email = $1', [emailFormatado]);
    if (check.rows.length > 0) {
      return res.status(409).json({ error: 'Este e-mail já está cadastrado no sistema.' });
    }

    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(senha, salt);

    const result = await pool.query(`
      INSERT INTO gaia_usuarios (nome, email, senha_hash, role)
      VALUES ($1, $2, $3, 'USER')
      RETURNING id, nome, email, role, criado_em;
    `, [nome.trim(), emailFormatado, hash]);

    const novoUsuario = result.rows[0];
    const token = jwt.sign(novoUsuario, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({
      status: 'ok',
      token,
      user: novoUsuario
    });
  } catch (err) {
    console.error('Erro no cadastro:', err);
    res.status(500).json({ error: 'Erro interno ao registrar usuário.' });
  }
});

// Obter dados do usuário logado atual
app.get('/api/auth/me', exigirAuth, (req, res) => {
  res.json({ user: req.user });
});

// ==========================================
// TELEMETRIA E INGESTÃO DO ESP32
// ==========================================

function decifrarComChave(raw, chaveString) {
  const iv = raw.subarray(0, 16);
  const ciphertext = raw.subarray(16);
  const key = Buffer.from(chaveString.padEnd(16, '0').slice(0, 16), 'utf8');

  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(true);
  let decrypted = decipher.update(ciphertext, null, 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}

function descriptografarPayload(cipherB64) {
  try {
    const raw = Buffer.from(cipherB64, 'base64');
    if (raw.length < 32) {
      throw new Error('Buffer criptografado inválido ou muito curto (< 32 bytes).');
    }

    // 1. Tenta decifrar com a chave oficial do Projeto GAIA
    try {
      return decifrarComChave(raw, AES_KEY);
    } catch (err1) {
      // 2. Fallback para a chave legada
      try {
        return decifrarComChave(raw, LEGACY_AES_KEY);
      } catch (err2) {
        throw new Error('Chave AES-128 inválida ou dados corrompidos.');
      }
    }
  } catch (err) {
    console.error('Falha ao descriptografar payload AES:', err.message);
    return null;
  }
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(tipo, dados) {
  const mensagem = JSON.stringify({ type: tipo, data: dados });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(mensagem);
    }
  });
}

async function processarTelemetria(req, res) {
  let doc = null;

  if (req.body && req.body.data) {
    doc = descriptografarPayload(req.body.data, AES_KEY);
    if (!doc) {
      return res.status(400).json({ error: 'Falha na descriptografia AES-128 ou chave incorreta.' });
    }
  } else if (req.body && (req.body.codSta || req.body.estacao)) {
    doc = req.body;
  } else {
    return res.status(400).json({ error: 'Formato de payload inválido.' });
  }

  const codSta = doc.codSta || doc.estacao || 'G00001';
  const ts = parseInt(doc.ts, 10) || Math.floor(Date.now() / 1000);

  // Validação de Token: aceita o Token Unificado do Projeto GAIA ou o token individual da estação
  const incomingToken = req.headers['x-station-token'] || 
                        (req.headers['authorization'] && req.headers['authorization'].startsWith('Bearer ') ? req.headers['authorization'].substring(7) : null) || 
                        doc.token;

  const isUnifiedProjectToken = (incomingToken && incomingToken === GAIA_PROJECT_TOKEN);

  try {
    const stationRow = await pool.query('SELECT api_token FROM gaia_estacoes WHERE cod_estacao = $1', [codSta]);
    if (stationRow.rows.length > 0 && stationRow.rows[0].api_token && !isUnifiedProjectToken) {
      if (!incomingToken || incomingToken !== stationRow.rows[0].api_token) {
        return res.status(401).json({ error: 'Token de autenticação da estação inválido ou ausente.' });
      }
    }

    const tBmp = doc.tB !== undefined && doc.tB !== null ? parseFloat(doc.tB) : null;
    const pressao = doc.p !== undefined && doc.p !== null ? parseFloat(doc.p) : null;
    const lux = doc.l !== undefined && doc.l !== null ? parseFloat(doc.l) : null;
    const umidade = doc.h !== undefined && doc.h !== null ? parseFloat(doc.h) : null;
    const tDht = doc.tD !== undefined && doc.tD !== null ? parseFloat(doc.tD) : null;
    const solo = doc.s !== undefined && doc.s !== null ? parseInt(doc.s, 10) : null;
    const tSolo = doc.tS !== undefined && doc.tS !== null ? parseFloat(doc.tS) : null;
    const tRef = doc.tRef !== undefined && doc.tRef !== null ? parseFloat(doc.tRef) : (tDht || tBmp);
    const dT = doc.dT !== undefined && doc.dT !== null ? parseFloat(doc.dT) : null;
    const qualidade = doc.q !== undefined && doc.q !== null ? parseInt(doc.q, 10) : 100;
    const po = doc.po !== undefined && doc.po !== null ? parseFloat(doc.po) : null;
    const vpd = doc.vpd !== undefined && doc.vpd !== null ? parseFloat(doc.vpd) : null;
    const et0 = doc.et0 !== undefined && doc.et0 !== null ? parseFloat(doc.et0) : null;
    const etc = doc.etc !== undefined && doc.etc !== null ? parseFloat(doc.etc) : null;
    const rs = doc.rs !== undefined && doc.rs !== null ? parseFloat(doc.rs) : null;
    const par = doc.par !== undefined && doc.par !== null ? parseFloat(doc.par) : null;
    const rf = doc.rf !== undefined && doc.rf !== null ? parseInt(doc.rf, 10) : 0;
    const rg = doc.rg !== undefined && doc.rg !== null ? parseFloat(doc.rg) : 0;
    const dp = doc.dp !== undefined && doc.dp !== null ? parseFloat(doc.dp) : null;
    const at = doc.at !== undefined && doc.at !== null ? Boolean(doc.at) : false;
    const itu = doc.itu !== undefined && doc.itu !== null ? parseFloat(doc.itu) : null;
    const hi = doc.hi !== undefined && doc.hi !== null ? parseFloat(doc.hi) : null;
    const heapMod = doc.heapMod !== undefined && doc.heapMod !== null ? parseInt(doc.heapMod, 10) : null;

    await pool.query(`
      INSERT INTO gaia_estacoes (cod_estacao, nome, api_token)
      VALUES ($1, $2, $3)
      ON CONFLICT (cod_estacao) DO NOTHING;
    `, [codSta, `Estação ${codSta}`, GAIA_PROJECT_TOKEN]);

    const insertQuery = `
      INSERT INTO gaia_telemetria (
        cod_estacao, timestamp_utc, temp_bmp, pressao, lux, umidade, temp_dht,
        umidade_solo, temp_solo, temp_ref, delta_temp, qualidade, ponto_orvalho,
        vpd, et0, etc, rs, par, rf, rg, dp, at, itu, hi, heap_mod, raw_payload
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
      RETURNING *;
    `;
    const values = [
      codSta, ts, tBmp, pressao, lux, umidade, tDht, solo, tSolo, tRef, dT,
      qualidade, po, vpd, et0, etc, rs, par, rf, rg, dp, at, itu, hi, heapMod, JSON.stringify(doc)
    ];

    const result = await pool.query(insertQuery, values);
    const leituraSalva = result.rows[0];

    broadcast('NOVA_LEITURA', leituraSalva);

    return res.status(200).json({
      status: 'ok',
      ack: ts,
      station: codSta,
      timestamp: ts,
      server_time: new Date().toISOString()
    });
  } catch (err) {
    console.error('Erro ao salvar no banco:', err.message);
    return res.status(500).json({ error: 'Erro interno ao gravar telemetria.' });
  }
}

app.post('/api/telemetria', processarTelemetria);
app.post('/maria-web', processarTelemetria);
app.post('/maria-web/', processarTelemetria);

// ==========================================
// ROTAS DE ESTAÇÕES COM REGRAS DE ACESSO
// ==========================================

// Listar estações com controle de visualização (Pública, Privada e Inadimplente)
app.get('/api/estacoes', obterUsuarioOpcional, async (req, res) => {
  try {
    const user = req.user; // Usuário decodificado do JWT se logado
    const isMaster = user && user.role === 'ADMIN';

    const result = await pool.query(`
      SELECT 
        e.cod_estacao,
        e.nome,
        e.cultura,
        e.latitude,
        e.longitude,
        e.visibilidade,
        e.status_financeiro,
        e.proprietario_id,
        e.api_token,
        e.ativo,
        t.timestamp_utc,
        t.data_hora,
        t.temp_ref,
        t.temp_dht,
        t.temp_bmp,
        t.umidade,
        t.umidade_solo,
        t.temp_solo,
        t.vpd,
        t.et0,
        t.etc,
        t.rs,
        t.par,
        t.rf,
        t.rg,
        t.dp,
        t.at,
        t.itu,
        t.hi,
        t.lux,
        t.pressao,
        t.qualidade,
        t.heap_mod
      FROM gaia_estacoes e
      LEFT JOIN LATERAL (
        SELECT * FROM gaia_telemetria 
        WHERE cod_estacao = e.cod_estacao 
        ORDER BY timestamp_utc DESC LIMIT 1
      ) t ON true
      ORDER BY e.cod_estacao;
    `);

    const agoraSegundos = Math.floor(Date.now() / 1000);
    const estacoes = result.rows.map(r => {
      let status = 'OFFLINE';
      let diffSegundos = null;

      if (r.timestamp_utc) {
        diffSegundos = agoraSegundos - parseInt(r.timestamp_utc, 10);
        if (diffSegundos < 360) status = 'ONLINE';
        else if (diffSegundos <= 900) status = 'DEEP_SLEEP';
        else status = 'OFFLINE';
      }

      // Regra 1: Checagem de Inadimplência / Pagamento Pendente
      const isPendente = r.status_financeiro === 'PENDENTE';

      // Regra 2: Checagem de Privacidade
      const isPrivada = r.visibilidade === 'PRIVADA';
      const isOwner = user && user.id === r.proprietario_id;

      // Determina se os dados de telemetria devem ser bloqueados
      let acesso_bloqueado = false;
      let motivo_bloqueio = null;

      if (!isMaster) {
        if (isPendente) {
          acesso_bloqueado = true;
          motivo_bloqueio = 'MENSALIDADE_PENDENTE';
        } else if (isPrivada && !isOwner) {
          acesso_bloqueado = true;
          motivo_bloqueio = 'ESTACAO_PRIVADA';
        }
      }

      return {
        cod_estacao: r.cod_estacao,
        nome: r.nome,
        cultura: r.cultura,
        latitude: parseFloat(r.latitude),
        longitude: parseFloat(r.longitude),
        visibilidade: r.visibilidade,
        status_financeiro: r.status_financeiro,
        status,
        segundos_desde_ultimo_envio: diffSegundos,
        acesso_bloqueado,
        motivo_bloqueio,
        // Se bloqueado, mascara os dados numéricos de sensores
        timestamp_utc: acesso_bloqueado ? null : r.timestamp_utc,
        data_hora: acesso_bloqueado ? null : r.data_hora,
        temp_ref: acesso_bloqueado ? null : r.temp_ref,
        temp_dht: acesso_bloqueado ? null : r.temp_dht,
        temp_bmp: acesso_bloqueado ? null : r.temp_bmp,
        umidade: acesso_bloqueado ? null : r.umidade,
        umidade_solo: acesso_bloqueado ? null : r.umidade_solo,
        temp_solo: acesso_bloqueado ? null : r.temp_solo,
        vpd: acesso_bloqueado ? null : r.vpd,
        et0: acesso_bloqueado ? null : r.et0,
        etc: acesso_bloqueado ? null : r.etc,
        rs: acesso_bloqueado ? null : r.rs,
        par: acesso_bloqueado ? null : r.par,
        rf: acesso_bloqueado ? null : r.rf,
        rg: acesso_bloqueado ? null : r.rg,
        dp: acesso_bloqueado ? null : r.dp,
        at: acesso_bloqueado ? null : r.at,
        itu: acesso_bloqueado ? null : r.itu,
        hi: acesso_bloqueado ? null : r.hi,
        lux: acesso_bloqueado ? null : r.lux,
        pressao: acesso_bloqueado ? null : r.pressao,
        qualidade: acesso_bloqueado ? null : r.qualidade,
        heap_mod: acesso_bloqueado ? null : r.heap_mod,
        api_token: (isMaster || isOwner) ? r.api_token : null
      };
    });

    res.json(estacoes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Histórico de leituras (com suporte a 24h, 1d, 7d, 30d, 6m, 1y e all)
app.get('/api/telemetria/historico', obterUsuarioOpcional, async (req, res) => {
  const estacao = req.query.estacao || 'G00001';
  const periodo = (req.query.periodo || '24h').toLowerCase();
  const user = req.user;
  const isMaster = user && user.role === 'ADMIN';

  try {
    // 1. Verifica permissões da estação
    const estCheck = await pool.query('SELECT * FROM gaia_estacoes WHERE cod_estacao = $1', [estacao]);
    if (estCheck.rows.length > 0) {
      const st = estCheck.rows[0];
      if (!isMaster) {
        if (st.status_financeiro === 'PENDENTE') {
          return res.status(403).json({
            error: 'Acesso suspenso: Estação com mensalidade pendente.',
            motivo: 'MENSALIDADE_PENDENTE'
          });
        }
        if (st.visibilidade === 'PRIVADA' && (!user || user.id !== st.proprietario_id)) {
          return res.status(403).json({
            error: 'Acesso restrito: Esta estação é privada.',
            motivo: 'ESTACAO_PRIVADA'
          });
        }
      }
    }

    const nowUtc = Math.floor(Date.now() / 1000);
    let cutoffTs = 0;
    let maxLimit = 500;

    switch (periodo) {
      case '24h':
      case '1d':
        cutoffTs = nowUtc - (24 * 3600);
        maxLimit = 150;
        break;
      case '7d':
      case '1s':
      case 'semana':
        cutoffTs = nowUtc - (7 * 86400);
        maxLimit = 250;
        break;
      case '30d':
      case '1m':
      case 'mes':
        cutoffTs = nowUtc - (30 * 86400);
        maxLimit = 350;
        break;
      case '6m':
      case '6meses':
        cutoffTs = nowUtc - (180 * 86400);
        maxLimit = 500;
        break;
      case '1y':
      case '1ano':
      case 'ano':
        cutoffTs = nowUtc - (365 * 86400);
        maxLimit = 600;
        break;
      case 'all':
      case 'todos':
      default:
        cutoffTs = 0;
        maxLimit = 1000;
        break;
    }

    if (req.query.limite) {
      maxLimit = parseInt(req.query.limite, 10) || maxLimit;
    }

    let result;
    if (cutoffTs > 0) {
      result = await pool.query(
        `SELECT * FROM (
          SELECT * FROM gaia_telemetria 
          WHERE cod_estacao = $1 AND timestamp_utc >= $2
          ORDER BY timestamp_utc DESC 
          LIMIT $3
        ) sub ORDER BY timestamp_utc ASC;`,
        [estacao, cutoffTs, maxLimit]
      );
    } else {
      result = await pool.query(
        `SELECT * FROM (
          SELECT * FROM gaia_telemetria 
          WHERE cod_estacao = $1 
          ORDER BY timestamp_utc DESC 
          LIMIT $2
        ) sub ORDER BY timestamp_utc ASC;`,
        [estacao, maxLimit]
      );
    }

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Atualizar dados de uma estação (apenas Master/Admin ou dono)
app.put('/api/estacoes/:cod', exigirAuth, async (req, res) => {
  const cod = req.params.cod;
  const { nome, cultura, latitude, longitude, visibilidade, status_financeiro, api_token } = req.body;
  const user = req.user;
  const isMaster = user.role === 'ADMIN';

  try {
    const estCheck = await pool.query('SELECT * FROM gaia_estacoes WHERE cod_estacao = $1', [cod]);
    if (estCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Estação não encontrada.' });
    }

    const st = estCheck.rows[0];
    if (!isMaster && st.proprietario_id !== user.id) {
      return res.status(403).json({ error: 'Você não tem permissão para alterar esta estação.' });
    }

    // Apenas Master pode alterar o status financeiro
    const novoStatusFin = isMaster ? status_financeiro || st.status_financeiro : st.status_financeiro;

    const result = await pool.query(`
      UPDATE gaia_estacoes
      SET 
        nome = COALESCE($1, nome),
        cultura = COALESCE($2, cultura),
        latitude = COALESCE($3, latitude),
        longitude = COALESCE($4, longitude),
        visibilidade = COALESCE($5, visibilidade),
        status_financeiro = COALESCE($6, status_financeiro),
        api_token = COALESCE($7, api_token),
        atualizado_em = CURRENT_TIMESTAMP
      WHERE cod_estacao = $8
      RETURNING *;
    `, [nome, cultura, latitude, longitude, visibilidade, novoStatusFin, api_token, cod]);

    broadcast('ESTACAO_ATUALIZADA', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint de simulação
app.post('/api/simular', async (req, res) => {
  const estacao = req.body.estacao || 'G00001';
  const tDht = (22 + Math.random() * 8).toFixed(1);
  const umidade = (55 + Math.random() * 30).toFixed(1);
  const pressao = (1012 + Math.random() * 6).toFixed(1);
  const lux = Math.floor(5000 + Math.random() * 35000);
  const solo = Math.floor(40 + Math.random() * 35);
  const tSolo = (parseFloat(tDht) - 1.5 + Math.random() * 0.8).toFixed(1);

  const a = 17.27, b = 237.7;
  const temp = parseFloat(tDht);
  const rh = parseFloat(umidade);
  const alpha = ((a * temp) / (b + temp)) + Math.log(rh / 100.0);
  const po = ((b * alpha) / (a - alpha)).toFixed(1);

  const es = 0.61078 * Math.exp((17.27 * temp) / (temp + 237.3));
  const ea = es * (rh / 100.0);
  const vpd = Math.max(0, es - ea).toFixed(3);

  const radRs = parseFloat((lux * 0.0079).toFixed(1));
  const par = parseFloat((lux * 0.018).toFixed(1));
  const et0 = (0.015 + (lux / 70000) * 0.035 + parseFloat(vpd) * 0.015).toFixed(4);
  const etc = parseFloat((parseFloat(et0) * 1.05).toFixed(4));
  const itu = parseFloat((0.8 * temp + (rh / 100) * (temp - 14.4) + 46.4).toFixed(1));
  const hi = parseFloat((temp + 0.5555 * (6.11 * Math.exp(5417.7530 * (1/273.16 - 1/(273.15 + parseFloat(po)))) - 10)).toFixed(1));

  const mockPayload = {
    codSta: estacao,
    token: GAIA_PROJECT_TOKEN,
    ts: Math.floor(Date.now() / 1000),
    tB: parseFloat(tDht) - 0.3,
    p: parseFloat(pressao),
    l: lux,
    h: parseFloat(umidade),
    tD: parseFloat(tDht),
    s: solo,
    tS: parseFloat(tSolo),
    tRef: parseFloat(tDht),
    dT: 0.3,
    q: 100,
    po: parseFloat(po),
    vpd: parseFloat(vpd),
    et0: parseFloat(et0),
    etc: etc,
    rs: radRs,
    par: par,
    rf: 0,
    rg: 0,
    dp: 0.0,
    at: false,
    itu: itu,
    hi: hi,
    heapMod: 412
  };

  req.body = mockPayload;
  return processarTelemetria(req, res);
});

// Endpoint para gerar histórico realista com cobertura de 24h, 7d, 30d, 6m e 1 ano
app.post('/api/estacoes/:cod/popular-historico', async (req, res) => {
  const cod = req.params.cod;
  const now = Math.floor(Date.now() / 1000);

  try {
    // Lista de timestamps para gerar:
    // 1. Últimas 24 horas (hora a hora)
    // 2. Dias 2 a 7 (4 vezes por dia)
    // 3. Dias 8 a 30 (2 vezes por dia)
    // 4. Dias 31 a 365 (1 vez a cada 2 dias)
    const timestamps = [];
    
    // 24h: 24 pontos
    for (let h = 24; h >= 1; h--) {
      timestamps.push(now - (h * 3600));
    }
    // 7d: dias 2 a 7 (4 leituras/dia)
    for (let d = 2; d <= 7; d++) {
      for (const h of [0, 6, 12, 18]) {
        timestamps.push(now - (d * 86400) + (h * 3600));
      }
    }
    // 30d: dias 8 a 30 (2 leituras/dia)
    for (let d = 8; d <= 30; d++) {
      for (const h of [6, 14]) {
        timestamps.push(now - (d * 86400) + (h * 3600));
      }
    }
    // 365d: dias 31 a 365 (1 leitura a cada 2 dias)
    for (let d = 32; d <= 365; d += 2) {
      timestamps.push(now - (d * 86400) + (13 * 3600));
    }

    // Ordena do mais antigo para o mais recente
    timestamps.sort((a, b) => a - b);

    // Remove leituras antigas para a estação para manter consistência
    await pool.query('DELETE FROM gaia_telemetria WHERE cod_estacao = $1', [cod]);

    for (const ts of timestamps) {
      const d = new Date(ts * 1000);
      const hora = d.getHours();
      const diaDoAno = Math.floor((ts % 31536000) / 86400);

      // Efeito sazonal ao longo do ano (Verão mais quente/chuvoso, Inverno mais ameno/seco)
      const sazonal = Math.sin(2 * Math.PI * (diaDoAno - 80) / 365);
      const tempBase = 18.0 + (sazonal * 4.5);

      // Ciclo diurno
      const solarFactor = (hora >= 6 && hora <= 18) ? Math.sin(Math.PI * (hora - 6) / 12) : 0;
      const rs = solarFactor > 0 ? parseFloat((solarFactor * (750 + sazonal * 100) + (Math.random() * 20 - 10)).toFixed(1)) : 0.0;
      const par = rs > 0 ? parseFloat((rs * 2.15).toFixed(1)) : 0.0;
      const lux = rs > 0 ? Math.round(rs * 115) : 0;

      const tempFactor = Math.sin(Math.PI * ((hora + 18) % 24) / 24);
      const temp = parseFloat((tempBase + 9.5 * Math.max(0, tempFactor) + (Math.random() * 0.8 - 0.4)).toFixed(1));
      const tempDht = temp;
      const tempBmp = parseFloat((temp - 0.2 + (Math.random() * 0.4 - 0.2)).toFixed(1));
      const tempRef = parseFloat(((tempDht + tempBmp) / 2).toFixed(1));

      const umid = parseFloat(Math.max(30, Math.min(95, (75 + sazonal * 10) - (temp - tempBase) * 3.5 + (Math.random() * 3 - 1.5))).toFixed(1));
      const solo = Math.round(Math.max(40, Math.min(85, (60 + sazonal * 12) + (Math.random() * 4 - 2))));
      const tempSolo = parseFloat((tempBase + 1.5 + (temp - tempBase) * 0.3).toFixed(1));

      // Psicrometria e agronômicos
      const es = 0.61078 * Math.exp((17.27 * tempRef) / (tempRef + 237.3));
      const ea = es * (umid / 100);
      const vpd = parseFloat(Math.max(0.1, es - ea).toFixed(3));
      const et0 = parseFloat(Math.max(0.01, 0.002 * rs + 0.02 * vpd).toFixed(4));
      const etc = parseFloat((et0 * 1.05).toFixed(4));

      const a = 17.27, b = 237.7;
      const alpha = ((a * tempRef) / (b + tempRef)) + Math.log(umid / 100);
      const po = parseFloat(((b * alpha) / (a - alpha)).toFixed(1));

      const pressao = parseFloat((1013.0 + 1.8 * Math.sin(hora * Math.PI / 6) + (Math.random() * 0.4 - 0.2)).toFixed(1));
      const dp = parseFloat(((Math.random() * 1.2) - 0.6).toFixed(1));
      const at = false;

      const itu = parseFloat((0.8 * tempRef + (umid / 100) * (tempRef - 14.4) + 46.4).toFixed(1));
      const hi = parseFloat((tempRef + (umid > 60 ? (umid - 60) * 0.1 : 0)).toFixed(1));
      const rf = umid >= 85 ? 2 : (umid >= 70 ? 1 : 0);
      const rg = (sazonal > 0.3 && Math.random() > 0.8) ? parseFloat((Math.random() * 15).toFixed(1)) : 0.0;
      const heapMod = Math.floor(390 + Math.random() * 30);

      await pool.query(`
        INSERT INTO gaia_telemetria (
          cod_estacao, timestamp_utc, data_hora, temp_bmp, pressao, lux, umidade, temp_dht,
          umidade_solo, temp_solo, temp_ref, delta_temp, qualidade, ponto_orvalho,
          vpd, et0, etc, rs, par, rf, rg, dp, at, itu, hi, heap_mod
        ) VALUES (
          $1, $2, to_timestamp($3), $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14,
          $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26
        );
      `, [
        cod, ts, ts, tempBmp, pressao, lux, umid, tempDht,
        solo, tempSolo, tempRef, Math.abs(parseFloat((tempDht - tempBmp).toFixed(1))), 100, po,
        vpd, et0, etc, rs, par, rf, rg, dp, at, itu, hi, heapMod
      ]);
    }

    // Atualiza cache da estação
    const ultima = await pool.query('SELECT * FROM gaia_telemetria WHERE cod_estacao = $1 ORDER BY timestamp_utc DESC LIMIT 1', [cod]);
    if (ultima.rows.length > 0) {
      broadcast('NOVA_LEITURA', ultima.rows[0]);
    }

    res.json({ status: 'ok', message: `${timestamps.length} registros (24h até 1 ano) gerados com sucesso para ${cod}` });
  } catch (err) {
    console.error('Erro ao popular histórico:', err);
    res.status(500).json({ error: err.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor GAIA com Autenticação e Regras de Estações ativo na porta ${PORT}`);
});
