const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3002;
const EXPECTED_DEVICE_TOKEN = process.env.DEVICE_TOKEN || 'STI_PONTO_ESP32_SECRET_KEY';

// Conexão com o banco PostgreSQL oficial do STI
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://server_admin:server_password_123@postgres:5432/app_db'
});

// =========================================================================
// INICIALIZAÇÃO E AUTO-MIGRAÇÃO DO BANCO DE DADOS (POSTGRESQL)
// =========================================================================
async function initDatabase() {
  try {
    const client = await pool.connect();
    try {
      // 1. Tabela de Colaboradores / Usuários
      await client.query(`
        CREATE TABLE IF NOT EXISTS ponto_usuarios (
          id SERIAL PRIMARY KEY,
          matricula VARCHAR(20) UNIQUE NOT NULL,
          nome VARCHAR(100) NOT NULL,
          tag_rfid VARCHAR(32) UNIQUE,
          senha VARCHAR(32),
          cargo VARCHAR(50),
          setor VARCHAR(50) DEFAULT 'STI',
          email VARCHAR(150),
          senha_web VARCHAR(255),
          nivel_permissao VARCHAR(20) DEFAULT 'OPERADOR',
          ativo BOOLEAN DEFAULT TRUE,
          criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Migração de colunas caso a tabela já existisse no schema antigo
      await client.query(`
        ALTER TABLE ponto_usuarios ADD COLUMN IF NOT EXISTS email VARCHAR(150);
        ALTER TABLE ponto_usuarios ADD COLUMN IF NOT EXISTS senha_web VARCHAR(255);
        ALTER TABLE ponto_usuarios ADD COLUMN IF NOT EXISTS nivel_permissao VARCHAR(20) DEFAULT 'OPERADOR';
      `);

      // 2. Tabela de Dispositivos ESP32 Autorizados
      await client.query(`
        CREATE TABLE IF NOT EXISTS ponto_dispositivos (
          id SERIAL PRIMARY KEY,
          codigo_dispositivo VARCHAR(50) UNIQUE NOT NULL,
          localizacao VARCHAR(100) NOT NULL,
          token_autorizacao VARCHAR(128) NOT NULL,
          ip_atual VARCHAR(45),
          ultimo_contato TIMESTAMP,
          ativo BOOLEAN DEFAULT TRUE,
          criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // 3. Tabela de Registros de Ponto (Batidas)
      await client.query(`
        CREATE TABLE IF NOT EXISTS ponto_registros (
          id SERIAL PRIMARY KEY,
          usuario_id INT REFERENCES ponto_usuarios(id) ON DELETE CASCADE,
          tag_id VARCHAR(32) NOT NULL,
          origem VARCHAR(10) NOT NULL,
          data_hora_dispositivo TIMESTAMP NOT NULL,
          data_hora_servidor TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          status_batida VARCHAR(10) NOT NULL,
          duracao_minutos INT DEFAULT 0,
          sincronizado_offline BOOLEAN DEFAULT FALSE,
          fechamento_automatico BOOLEAN DEFAULT FALSE,
          dispositivo_codigo VARCHAR(50) DEFAULT 'ESP32_PONTO_MONTEBOT',
          observacoes TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_ponto_usuarios_rfid ON ponto_usuarios(tag_rfid);
        CREATE INDEX IF NOT EXISTS idx_ponto_usuarios_senha ON ponto_usuarios(senha);
        CREATE INDEX IF NOT EXISTS idx_ponto_registros_data ON ponto_registros(data_hora_dispositivo);
        CREATE INDEX IF NOT EXISTS idx_ponto_registros_usr_data ON ponto_registros(usuario_id, data_hora_dispositivo);
      `);

      await client.query(`
        ALTER TABLE ponto_registros ADD COLUMN IF NOT EXISTS fechamento_automatico BOOLEAN DEFAULT FALSE;
        ALTER TABLE ponto_registros ADD COLUMN IF NOT EXISTS observacoes TEXT;
        ALTER TABLE ponto_registros ADD COLUMN IF NOT EXISTS dispositivo_codigo VARCHAR(50) DEFAULT 'ESP32_PONTO_MONTEBOT';
      `);

      // Dispositivos autorizados
      await client.query(`
        INSERT INTO ponto_dispositivos (codigo_dispositivo, localizacao, token_autorizacao)
        VALUES ('ESP32_PONTO_MONTEBOT', 'Portaria MonteBot', 'STI_PONTO_ESP32_SECRET_KEY')
        ON CONFLICT (codigo_dispositivo) DO NOTHING;
      `);

      // Admin padrão: Leonardo Cardoso
      const adminEmail = 'cardosoleonardo1327@gmail.com';
      const adminHash = bcrypt.hashSync('swordfish', 10);
      const adminCheck = await client.query('SELECT id, senha_web FROM ponto_usuarios WHERE LOWER(email) = $1', [adminEmail]);
      if (adminCheck.rows.length === 0) {
        await client.query(`
          INSERT INTO ponto_usuarios (matricula, nome, tag_rfid, senha, cargo, setor, email, senha_web, nivel_permissao)
          VALUES ('STI001', 'Leonardo Cardoso', 'A1B2C3D4', '1234', 'Engenheiro / Desenvolvedor', 'MonteBot / STI', $1, $2, 'ADMIN')
          ON CONFLICT (matricula) DO UPDATE SET
            nome = EXCLUDED.nome,
            email = EXCLUDED.email,
            senha_web = EXCLUDED.senha_web,
            nivel_permissao = 'ADMIN',
            setor = 'MonteBot / STI';
        `, [adminEmail, adminHash]);
        console.log(`[INIT PONTO] Gestor Admin inicializado: ${adminEmail}`);
      } else {
        await client.query(`
          UPDATE ponto_usuarios 
          SET nivel_permissao = 'ADMIN', senha_web = $1, setor = 'MonteBot / STI' 
          WHERE LOWER(email) = $2;
        `, [adminHash, adminEmail]);
      }

      console.log('[INIT PONTO] Tabelas e permissões de Ponto Eletrônico inicializadas com sucesso.');
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[ERRO INIT PONTO DB]', err.message);
  }
}
initDatabase();


// =========================================================================
// MIDDLEWARES DE SEGURANÇA E CABEÇALHOS HTTP
// =========================================================================
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

app.use(cors());
app.use(express.json({ limit: '100kb' })); // Limita tamanho do body contra DoS
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate Limiter contra Força Bruta no Login (Máximo 20 falhas a cada 15 minutos por IP; logins corretos não contam)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas tentativas de login incorretas. Por segurança, tente novamente em 15 minutos.' }
});

// =========================================================================
// GERENCIADOR DE CAPTURA EM TEMPO REAL DE TAGS RFID NÃO CADASTRADAS
// =========================================================================
let ultimaTagCapturada = {
  tagId: null,
  dataHora: null,
  dispositivo: null
};

// =========================================================================
// SESSÕES / TOKENS EM MEMÓRIA
// =========================================================================
const sessoesAtivas = new Map();

function gerarTokenSessao(usuario) {
  const token = crypto.randomBytes(32).toString('hex');
  sessoesAtivas.set(token, {
    userId: usuario.id,
    nome: usuario.nome,
    email: usuario.email,
    nivel: usuario.nivel_permissao,
    criadoEm: Date.now()
  });
  return token;
}

function middlewareVerificarAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ erro: 'Autenticação necessária. Faça login como Administrador.' });
  }

  const token = authHeader.split(' ')[1];
  const sessao = sessoesAtivas.get(token);

  if (!sessao) {
    return res.status(401).json({ erro: 'Sessão expirada ou inválida. Faça login novamente.' });
  }

  if (sessao.nivel !== 'ADMIN') {
    return res.status(403).json({ erro: 'Acesso negado. Apenas administradores podem executar esta ação.' });
  }

  req.usuarioLogado = sessao;
  next();
}

// =========================================================================
// FUNÇÃO CENTRAL: PROCESSAR BATIDA COM FECHAMENTO AUTOMÁTICO (8 HORAS)
// =========================================================================
async function processarBatida(client, tagId, origem, dtEvento, sincronizadoOffline = false, dispositivo = 'ESP32_PONTO_MONTEBOT') {
  const tagLimpa = String(tagId).trim().toUpperCase();

  // 1. Localiza o Colaborador por Tag RFID ou Senha
  const userRes = await client.query(`
    SELECT * FROM ponto_usuarios 
    WHERE (UPPER(tag_rfid) = $1 OR senha = $2) AND ativo = TRUE 
    LIMIT 1;
  `, [tagLimpa, tagLimpa]);

  if (userRes.rows.length === 0) {
    // Guarda na memória a última tag não cadastrada para captura imediata pelo dashboard
    ultimaTagCapturada = {
      tagId: tagLimpa,
      origem: origem,
      dataHora: dtEvento,
      dispositivo: dispositivo
    };
    console.log(`[CAPTURA TAG] Tag nao cadastrada detectada: ${tagLimpa} (${origem})`);
    return null;
  }

  const usuario = userRes.rows[0];

  // 2. Busca o último registro de ponto deste colaborador
  const lastRes = await client.query(`
    SELECT * FROM ponto_registros 
    WHERE usuario_id = $1 
    ORDER BY data_hora_dispositivo DESC 
    LIMIT 1;
  `, [usuario.id]);

  let statusBatida = 'aberta';
  let duracaoMinutos = 0;
  let totalFormatado = '';
  let fechamentoAuto = false;

  if (lastRes.rows.length > 0 && lastRes.rows[0].status_batida === 'aberta') {
    const dtEntrada = new Date(lastRes.rows[0].data_hora_dispositivo);
    const deltaMs = dtEvento.getTime() - dtEntrada.getTime();
    const horasDiferenca = deltaMs / (1000 * 60 * 60);

    // REGRA DE FECHAMENTO AUTOMÁTICO:
    // Se a entrada foi em outro dia OU se passaram mais de 8 horas contínuas sem registrar saída:
    const dataEntradaStr = dtEntrada.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const dataEventoStr  = dtEvento.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    if (dataEntradaStr !== dataEventoStr || horasDiferenca > 8) {
      console.log(`[AUTO-CLOSE] Fechamento automático disparado para ${usuario.nome} (Entrada anterior: ${dtEntrada.toISOString()})`);
      
      await client.query(`
        UPDATE ponto_registros 
        SET status_batida = 'fechada', 
            fechamento_automatico = TRUE,
            duracao_minutos = 0,
            observacoes = 'Fechamento automático por virada de dia / jornada excedeu 8 horas'
        WHERE id = $1;
      `, [lastRes.rows[0].id]);

      statusBatida = 'aberta';
      duracaoMinutos = 0;
      totalFormatado = '';
    } else {
      statusBatida = 'fechada';
      duracaoMinutos = Math.max(0, Math.floor(deltaMs / (1000 * 60)));
      const horas = Math.floor(duracaoMinutos / 60);
      const minutos = duracaoMinutos % 60;
      totalFormatado = `${String(horas).padStart(2, '0')}h${String(minutos).padStart(2, '0')}m`;
    }
  } else {
    statusBatida = 'aberta';
  }

  // 3. Gravação da nova batida no banco
  await client.query(`
    INSERT INTO ponto_registros 
    (usuario_id, tag_id, origem, data_hora_dispositivo, status_batida, duracao_minutos, sincronizado_offline, fechamento_automatico, dispositivo_codigo)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);
  `, [
    usuario.id,
    tagLimpa,
    origem,
    dtEvento,
    statusBatida,
    duracaoMinutos,
    sincronizadoOffline,
    fechamentoAuto,
    dispositivo
  ]);

  const horaFormatada = dtEvento.toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo'
  });

  return {
    status: statusBatida,
    nome: usuario.nome,
    hora: horaFormatada,
    total: totalFormatado,
    mensagem: statusBatida === 'aberta' ? 'Entrada registrada com sucesso' : 'Saida registrada com sucesso'
  };
}

// =========================================================================
// ROTINA PERIÓDICA: FECHAMENTO NOTURNO AUTOMÁTICO (A CADA 30 MINUTOS)
// =========================================================================
setInterval(async () => {
  try {
    const client = await pool.connect();
    try {
      const res = await client.query(`
        UPDATE ponto_registros 
        SET status_batida = 'fechada',
            fechamento_automatico = TRUE,
            duracao_minutos = 0,
            observacoes = 'Fechamento automático periódico (jornada excedeu 8 horas)'
        WHERE status_batida = 'aberta' 
          AND data_hora_dispositivo < NOW() - INTERVAL '8 hours';
      `);
      if (res.rowCount > 0) {
        console.log(`[VARREDURA AUTO-CLOSE] ${res.rowCount} pontos abertos antigos foram encerrados automaticamente.`);
      }
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[ERRO VARREDURA NOTURNA]', err);
  }
}, 30 * 60 * 1000);

// =========================================================================
// ENDPOINTS DO ESP32 (HARDWARE)
// =========================================================================

// Endpoint de Sincronização de Data e Hora Oficial (Fallback de NTP mesmo sem internet externa)
app.get('/ponto/hora', (req, res) => {
  const agora = new Date();
  const timestamp = Math.floor(agora.getTime() / 1000);
  return res.status(200).json({
    sucesso: true,
    timestamp: timestamp,
    data: agora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
    hora: agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
    data_hora: agora.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
    timezone: 'America/Sao_Paulo',
    gmt_offset: -10800
  });
});

app.post('/ponto/registro', async (req, res) => {
  try {
    const { tag_id, origem, timestamp } = req.body;
    if (!tag_id) {
      return res.status(400).json({ erro: 'tag_id e obrigatorio' });
    }

    const tokenHeader = req.headers['x-device-token'];
    if (tokenHeader && tokenHeader !== EXPECTED_DEVICE_TOKEN && tokenHeader !== 'MONTEBOT_PONTO_ESP32_SECRET_KEY' && tokenHeader !== 'STI_PONTO_ESP32_SECRET_KEY') {
      return res.status(401).json({ erro: 'Token de dispositivo invalido' });
    }

    const dtEvento = timestamp && timestamp > 1000000000 
      ? new Date(timestamp * 1000) 
      : new Date();

    const client = await pool.connect();
    try {
      const resultado = await processarBatida(client, tag_id, origem || 'rfid', dtEvento, false);
      if (!resultado) {
        return res.status(404).json({ erro: 'Cartao ou senha nao cadastrados' });
      }
      return res.status(200).json(resultado);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[ERRO REGISTRO]', err);
    return res.status(500).json({ erro: 'Erro interno ao processar ponto' });
  }
});

app.post('/ponto/sincronizar', async (req, res) => {
  try {
    const { dispositivo, registros } = req.body;
    if (!Array.isArray(registros) || registros.length === 0) {
      return res.status(400).json({ erro: 'Formato de lote invalido' });
    }

    const tokenHeader = req.headers['x-device-token'];
    if (tokenHeader && tokenHeader !== EXPECTED_DEVICE_TOKEN && tokenHeader !== 'MONTEBOT_PONTO_ESP32_SECRET_KEY' && tokenHeader !== 'STI_PONTO_ESP32_SECRET_KEY') {
      return res.status(401).json({ erro: 'Token de dispositivo invalido' });
    }

    const ordenados = [...registros].sort((a, b) => a.timestamp - b.timestamp);
    const client = await pool.connect();
    let processados = 0;
    try {
      await client.query('BEGIN');
      for (const item of ordenados) {
        const dtEvento = item.timestamp && item.timestamp > 1000000000 
          ? new Date(item.timestamp * 1000) 
          : new Date();
        const resItem = await processarBatida(client, item.tag_id, item.origem || 'rfid', dtEvento, true, dispositivo || 'ESP32_PONTO_MONTEBOT');
        if (resItem) processados++;
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    return res.status(200).json({
      sucesso: true,
      dispositivo: dispositivo || 'ESP32_PONTO_MONTEBOT',
      processados,
      total: registros.length
    });
  } catch (err) {
    console.error('[ERRO SYNC]', err);
    return res.status(500).json({ erro: 'Erro ao sincronizar fila offline' });
  }
});

// =========================================================================
// ENDPOINT DE CAPTURA RÁPIDA DE TAG (FACILIDADE DE CADASTRO)
// =========================================================================
app.get('/api/captura-tag', (req, res) => {
  if (!ultimaTagCapturada.tagId) {
    return res.status(200).json({ disponivel: false, mensagem: 'Nenhuma tag aproximada recentemente' });
  }

  // Só considera tags aproximadas nos últimos 10 minutos
  const dezMinutosAtras = Date.now() - (10 * 60 * 1000);
  if (new Date(ultimaTagCapturada.dataHora).getTime() < dezMinutosAtras) {
    return res.status(200).json({ disponivel: false, mensagem: 'Última tag expirada' });
  }

  return res.status(200).json({
    disponivel: true,
    tagId: ultimaTagCapturada.tagId,
    origem: ultimaTagCapturada.origem,
    hora: new Date(ultimaTagCapturada.dataHora).toLocaleTimeString('pt-BR')
  });
});

// =========================================================================
// AUTENTICAÇÃO COM HASH BCRYPT E PROTEÇÃO CONTRA FORÇA BRUTA
// =========================================================================
app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) {
      return res.status(400).json({ erro: 'Email e senha são obrigatórios' });
    }

    const emailLimpo = email.trim().toLowerCase();

    const client = await pool.connect();
    try {
      const userRes = await client.query(`
        SELECT id, nome, email, senha_web, nivel_permissao, cargo, setor 
        FROM ponto_usuarios 
        WHERE LOWER(email) = $1 AND ativo = TRUE 
        LIMIT 1;
      `, [emailLimpo]);

      if (userRes.rows.length === 0) {
        return res.status(401).json({ erro: 'Usuário ou senha inválidos' });
      }

      const usuario = userRes.rows[0];

      // Verificação da senha com suporte a Bcrypt (e migração automática de texto plano antigo)
      let senhaCorreta = false;
      const ehHashBcrypt = usuario.senha_web && usuario.senha_web.startsWith('$2');

      if (ehHashBcrypt) {
        senhaCorreta = await bcrypt.compare(senha, usuario.senha_web);
      } else {
        // Se a senha antiga ainda estava em texto puro (ex: 'swordfish')
        if (usuario.senha_web === senha) {
          senhaCorreta = true;
          // Atualiza imediatamente para o hash Bcrypt no banco por segurança!
          const salt = await bcrypt.genSalt(10);
          const hashNovo = await bcrypt.hash(senha, salt);
          await client.query('UPDATE ponto_usuarios SET senha_web = $1 WHERE id = $2', [hashNovo, usuario.id]);
          console.log(`[SEGURANÇA] Senha de ${usuario.email} migrada com sucesso para hash Bcrypt!`);
        }
      }

      if (!senhaCorreta) {
        return res.status(401).json({ erro: 'Usuário ou senha inválidos' });
      }

      const token = gerarTokenSessao(usuario);

      return res.status(200).json({
        sucesso: true,
        token,
        usuario: {
          id: usuario.id,
          nome: usuario.nome,
          email: usuario.email,
          nivel: usuario.nivel_permissao,
          setor: usuario.setor
        }
      });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[ERRO LOGIN]', err);
    return res.status(500).json({ erro: 'Erro interno no login' });
  }
});

app.get('/api/usuario/me', (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(200).json({ logado: false });
  }

  const token = authHeader.split(' ')[1];
  const sessao = sessoesAtivas.get(token);

  if (!sessao) {
    return res.status(200).json({ logado: false });
  }

  return res.status(200).json({
    logado: true,
    usuario: sessao
  });
});

app.post('/api/logout', (req, res) => {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    sessoesAtivas.delete(token);
  }
  return res.status(200).json({ sucesso: true });
});

// =========================================================================
// ENDPOINTS DO DASHBOARD WEB (VISÍVEL POR TODOS - PÚBLICO)
// =========================================================================

app.get('/api/dashboard', async (req, res) => {
  try {
    const dataFiltro = req.query.data || new Date().toISOString().slice(0, 10);
    const inicioDia = `${dataFiltro} 00:00:00`;
    const fimDia = `${dataFiltro} 23:59:59`;

    const client = await pool.connect();
    try {
      const totalColabRes = await client.query('SELECT COUNT(*) as total FROM ponto_usuarios WHERE ativo = TRUE;');
      const totalColaboradores = parseInt(totalColabRes.rows[0].total, 10);

      const registrosHojeRes = await client.query(`
        SELECT 
          r.id,
          r.usuario_id,
          u.nome,
          u.matricula,
          u.setor,
          r.data_hora_dispositivo,
          r.status_batida,
          r.duracao_minutos,
          r.sincronizado_offline,
          r.fechamento_automatico,
          r.origem
        FROM ponto_registros r
        JOIN ponto_usuarios u ON r.usuario_id = u.id
        WHERE r.data_hora_dispositivo BETWEEN $1 AND $2
        ORDER BY r.data_hora_dispositivo ASC;
      `, [inicioDia, fimDia]);

      const registrosHoje = registrosHojeRes.rows;
      const mapaUsuarios = {};
      
      const todosUsuariosRes = await client.query(`
        SELECT id, nome, matricula, setor, cargo, nivel_permissao FROM ponto_usuarios WHERE ativo = TRUE ORDER BY nome ASC;
      `);

      todosUsuariosRes.rows.forEach(u => {
        mapaUsuarios[u.id] = {
          id: u.id,
          nome: u.nome,
          matricula: u.matricula,
          setor: u.setor || 'MonteBot',
          cargo: u.cargo || '',
          nivel: u.nivel_permissao || 'OPERADOR',
          batidas: [],
          statusAtual: 'Ausente',
          primeiraEntrada: '--:--',
          ultimaSaida: '--:--',
          minutosTrabalhadosHoje: 0,
          horasFormatadas: '00h 00m',
          teveFechamentoAutomatico: false
        };
      });

      let presentesAgoraContador = 0;

      registrosHoje.forEach(reg => {
        if (!mapaUsuarios[reg.usuario_id]) return;

        const u = mapaUsuarios[reg.usuario_id];
        const horaStr = new Date(reg.data_hora_dispositivo).toLocaleTimeString('pt-BR', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'America/Sao_Paulo'
        });

        if (reg.fechamento_automatico) {
          u.teveFechamentoAutomatico = true;
        }

        u.batidas.push({
          id: reg.id,
          hora: horaStr,
          tipo: reg.status_batida,
          duracao: reg.duracao_minutos,
          origem: reg.origem,
          offline: reg.sincronizado_offline,
          fechamentoAuto: reg.fechamento_automatico
        });

        if (reg.status_batida === 'aberta') {
          if (u.primeiraEntrada === '--:--') {
            u.primeiraEntrada = horaStr;
          }
          u.statusAtual = 'Trabalhando';
        } else if (reg.status_batida === 'fechada') {
          u.ultimaSaida = horaStr;
          u.statusAtual = 'Finalizado';
          u.minutosTrabalhadosHoje += reg.duracao_minutos;
        }
      });

      const agora = new Date();
      const ehHoje = (dataFiltro === agora.toISOString().slice(0, 10));

      Object.values(mapaUsuarios).forEach(u => {
        if (u.statusAtual === 'Trabalhando') {
          presentesAgoraContador++;
          if (ehHoje) {
            const ultimaEntrada = registrosHoje
              .filter(r => r.usuario_id === u.id && r.status_batida === 'aberta')
              .pop();
            if (ultimaEntrada) {
              const diffMin = Math.max(0, Math.floor((agora - new Date(ultimaEntrada.data_hora_dispositivo)) / 60000));
              u.minutosTrabalhadosHoje += diffMin;
            }
          }
        }

        const h = Math.floor(u.minutosTrabalhadosHoje / 60);
        const m = u.minutosTrabalhadosHoje % 60;
        u.horasFormatadas = `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m`;
      });

      const somatorioMinutosEquipe = Object.values(mapaUsuarios).reduce((acc, curr) => acc + curr.minutosTrabalhadosHoje, 0);
      const somaH = Math.floor(somatorioMinutosEquipe / 60);
      const somaM = somatorioMinutosEquipe % 60;
      const somatorioHorasEquipe = `${somaH}h ${String(somaM).padStart(2, '0')}m`;

      return res.status(200).json({
        data: dataFiltro,
        totalColaboradores,
        presentesAgora: presentesAgoraContador,
        somatorioHorasEquipe,
        totalBatidasHoje: registrosHoje.length,
        espelho: Object.values(mapaUsuarios)
      });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[ERRO DASHBOARD]', err);
    return res.status(500).json({ erro: 'Erro ao carregar dados do dashboard' });
  }
});

app.get('/api/registros', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 50;
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT 
          r.id,
          u.nome,
          u.matricula,
          u.setor,
          r.tag_id,
          r.origem,
          r.data_hora_dispositivo,
          r.status_batida,
          r.duracao_minutos,
          r.sincronizado_offline,
          r.fechamento_automatico,
          r.dispositivo_codigo
        FROM ponto_registros r
        JOIN ponto_usuarios u ON r.usuario_id = u.id
        ORDER BY r.data_hora_dispositivo DESC
        LIMIT $1;
      `, [limit]);

      return res.status(200).json(result.rows);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[ERRO REGISTROS]', err);
    return res.status(500).json({ erro: 'Erro ao buscar histórico de registros' });
  }
});

// =========================================================================
// GESTÃO DE COLABORADORES (RESTRITO A ADMINISTRADORES LOGADOS)
// =========================================================================

app.get('/api/usuarios', middlewareVerificarAdmin, async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT id, matricula, nome, tag_rfid, senha, cargo, setor, email, nivel_permissao, ativo, criado_em
        FROM ponto_usuarios
        ORDER BY ativo DESC, nome ASC;
      `);
      return res.status(200).json(result.rows);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[ERRO LISTAR USUARIOS]', err);
    return res.status(500).json({ erro: 'Erro ao listar colaboradores' });
  }
});

app.post('/api/usuarios', middlewareVerificarAdmin, async (req, res) => {
  try {
    const { matricula, nome, tag_rfid, senha, cargo, setor, email, senha_web, nivel_permissao } = req.body;
    if (!matricula || !nome) {
      return res.status(400).json({ erro: 'Matrícula e nome são obrigatórios' });
    }

    const tagLimpa = tag_rfid && String(tag_rfid).trim() !== '' ? String(tag_rfid).trim().toUpperCase() : null;
    const nivelFinal = (nivel_permissao === 'ADMIN') ? 'ADMIN' : 'OPERADOR';
    const emailLimpo = email && String(email).trim() !== '' ? String(email).trim().toLowerCase() : null;

    let hashSenhaWeb = null;
    if (senha_web && senha_web.length > 0) {
      const salt = await bcrypt.genSalt(10);
      hashSenhaWeb = await bcrypt.hash(senha_web, salt);
    }

    const client = await pool.connect();
    try {
      const result = await client.query(`
        INSERT INTO ponto_usuarios 
        (matricula, nome, tag_rfid, senha, cargo, setor, email, senha_web, nivel_permissao)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id, matricula, nome, tag_rfid, cargo, setor, email, nivel_permissao, ativo;
      `, [
        matricula.trim(),
        nome.trim(),
        tagLimpa,
        senha ? String(senha).trim() : null,
        cargo ? cargo.trim() : null,
        setor ? setor.trim() : 'MonteBot',
        emailLimpo,
        hashSenhaWeb,
        nivelFinal
      ]);

      return res.status(201).json(result.rows[0]);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[ERRO NOVO USUARIO]', err);
    return res.status(500).json({ erro: 'Falha ao cadastrar colaborador (matrícula, email ou tag RFID já existente)' });
  }
});

app.put('/api/usuarios/:id', middlewareVerificarAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { matricula, nome, tag_rfid, senha, cargo, setor, email, senha_web, nivel_permissao, ativo } = req.body;

    const client = await pool.connect();
    try {
      const updates = [];
      const params = [];
      let idx = 1;

      if (matricula !== undefined) {
        updates.push(`matricula = $${idx++}`);
        params.push(matricula.trim());
      }
      if (nome !== undefined) {
        updates.push(`nome = $${idx++}`);
        params.push(nome.trim());
      }
      if (tag_rfid !== undefined) {
        const tag = tag_rfid && String(tag_rfid).trim() !== '' ? String(tag_rfid).trim().toUpperCase() : null;
        updates.push(`tag_rfid = $${idx++}`);
        params.push(tag);
      }
      if (cargo !== undefined) {
        updates.push(`cargo = $${idx++}`);
        params.push(cargo ? cargo.trim() : null);
      }
      if (setor !== undefined) {
        updates.push(`setor = $${idx++}`);
        params.push(setor ? setor.trim() : 'MonteBot');
      }
      if (email !== undefined) {
        updates.push(`email = $${idx++}`);
        params.push(email && String(email).trim() !== '' ? String(email).trim().toLowerCase() : null);
      }
      if (nivel_permissao !== undefined) {
        updates.push(`nivel_permissao = $${idx++}`);
        params.push(nivel_permissao === 'ADMIN' ? 'ADMIN' : 'OPERADOR');
      }
      if (ativo !== undefined) {
        updates.push(`ativo = $${idx++}`);
        params.push(Boolean(ativo));
      }
      if (senha !== undefined) {
        updates.push(`senha = $${idx++}`);
        params.push(senha && String(senha).trim() !== '' ? String(senha).trim() : null);
      }
      if (senha_web !== undefined && String(senha_web).trim() !== '') {
        const hash = await bcrypt.hash(String(senha_web).trim(), 10);
        updates.push(`senha_web = $${idx++}`);
        params.push(hash);
      }

      if (updates.length === 0) {
        return res.status(400).json({ erro: 'Nenhum campo fornecido para atualização' });
      }

      params.push(id);
      const query = `UPDATE ponto_usuarios SET ${updates.join(', ')} WHERE id = $${idx} RETURNING id, matricula, nome, tag_rfid, cargo, setor, email, nivel_permissao, ativo;`;

      const result = await client.query(query, params);
      if (result.rows.length === 0) {
        return res.status(404).json({ erro: 'Colaborador não encontrado' });
      }

      return res.status(200).json(result.rows[0]);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[ERRO EDITAR USUARIO]', err);
    return res.status(500).json({ erro: 'Erro ao atualizar colaborador (verifique matrícula, email ou tag duplicada)' });
  }
});

app.post('/api/usuarios/:id/reativar', middlewareVerificarAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const client = await pool.connect();
    try {
      const result = await client.query('UPDATE ponto_usuarios SET ativo = TRUE WHERE id = $1 RETURNING id, nome;', [id]);
      if (result.rows.length === 0) {
        return res.status(404).json({ erro: 'Colaborador não encontrado' });
      }
      return res.status(200).json({ sucesso: true, mensagem: `Colaborador ${result.rows[0].nome} reativado com sucesso` });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[ERRO REATIVAR USUARIO]', err);
    return res.status(500).json({ erro: 'Erro ao reativar colaborador' });
  }
});

app.delete('/api/usuarios/:id', middlewareVerificarAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const permanente = req.query.permanente === 'true';
    const client = await pool.connect();
    try {
      if (permanente) {
        const result = await client.query('DELETE FROM ponto_usuarios WHERE id = $1 RETURNING id, nome;', [id]);
        if (result.rows.length === 0) {
          return res.status(404).json({ erro: 'Colaborador não encontrado' });
        }
        return res.status(200).json({ sucesso: true, mensagem: `Colaborador ${result.rows[0].nome} excluído permanentemente` });
      } else {
        const result = await client.query('UPDATE ponto_usuarios SET ativo = FALSE WHERE id = $1 RETURNING id, nome;', [id]);
        if (result.rows.length === 0) {
          return res.status(404).json({ erro: 'Colaborador não encontrado' });
        }
        return res.status(200).json({ sucesso: true, mensagem: `Colaborador ${result.rows[0].nome} desativado com sucesso` });
      }
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[ERRO EXCLUIR USUARIO]', err);
    return res.status(500).json({ erro: 'Erro ao processar exclusão/desativação do colaborador' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[PONTO MONTEBOT] Servidor rodando na porta ${PORT} com proteção Bcrypt e Rate-Limit ativas.`);
});
