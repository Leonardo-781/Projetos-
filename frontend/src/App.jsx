import React, { useState, useEffect, useRef } from 'react';
import L from 'leaflet';
import {
  Sprout,
  Activity,
  Gauge,
  Droplets,
  Thermometer,
  CloudRain,
  Sun,
  Wind,
  Filter,
  X,
  Send,
  MapPin,
  TrendingUp,
  RefreshCw,
  Edit3,
  CheckCircle2,
  Clock,
  ArrowLeft,
  Navigation,
  Check,
  Compass,
  FileText,
  Lock,
  Unlock,
  AlertTriangle,
  User,
  LogOut,
  Shield,
  CreditCard,
  Eye,
  EyeOff,
  Download,
  Database,
  Zap,
  Layers,
  Cpu,
  Calendar
} from 'lucide-react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
} from 'chart.js';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

export default function App() {
  const [estacoes, setEstacoes] = useState([]);
  const [selectedStation, setSelectedStation] = useState(null);
  const [stationHistory, setStationHistory] = useState([]);
  const [currentView, setCurrentView] = useState('map'); // 'map' or 'dashboard'
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [visibilityFilter, setVisibilityFilter] = useState('ALL');
  const [chartFilter, setChartFilter] = useState('ALL'); // 'ALL' or specific category
  const [selectedPeriod, setSelectedPeriod] = useState('24h'); // '24h', '7d', '30d', '6m', '1y', 'all'
  const [wsConnected, setWsConnected] = useState(false);

  // Estados de Autenticação
  const [user, setUser] = useState(null);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authMode, setAuthMode] = useState('login'); // 'login' or 'register'
  const [authForm, setAuthForm] = useState({ nome: '', email: '', senha: '' });
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  // Estados de Edição da Estação
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editForm, setEditForm] = useState({
    nome: '',
    cultura: '',
    latitude: 0,
    longitude: 0,
    visibilidade: 'PUBLICA',
    status_financeiro: 'ATIVO'
  });

  const mapRef = useRef(null);
  const leafletMap = useRef(null);
  const markersGroup = useRef(null);
  const baseLayers = useRef({});

  // Helper de cabeçalho com Token
  const getAuthHeaders = () => {
    const token = localStorage.getItem('gaia_token');
    return token ? { 'Authorization': `Bearer ${token}` } : {};
  };

  // 1. Carregar usuário logado do token
  const verificarSessao = async () => {
    const token = localStorage.getItem('gaia_token');
    if (!token) {
      setUser(null);
      return;
    }
    try {
      const res = await fetch('/api/auth/me', { headers: { 'Authorization': `Bearer ${token}` } });
      if (res.ok) {
        const data = await res.json();
        setUser(data.user);
      } else {
        localStorage.removeItem('gaia_token');
        setUser(null);
      }
    } catch (e) {
      console.error(e);
      setUser(null);
    }
  };

  // 2. Carregar lista de estações (com permissões aplicadas)
  const carregarEstacoes = async () => {
    try {
      const res = await fetch('/api/estacoes', { headers: getAuthHeaders() });
      const data = await res.json();
      setEstacoes(data);
      return data;
    } catch (err) {
      console.error('Erro ao carregar estações:', err);
      return [];
    }
  };

  // 3. Carregar Histórico da Estação com filtro de período
  const carregarHistorico = async (cod, periodo = selectedPeriod) => {
    try {
      const res = await fetch(`/api/telemetria/historico?estacao=${cod}&periodo=${periodo}`, { headers: getAuthHeaders() });
      if (res.ok) {
        const data = await res.json();
        setStationHistory(data);
      } else {
        setStationHistory([]);
      }
    } catch (err) {
      console.error('Erro ao carregar histórico:', err);
      setStationHistory([]);
    }
  };

  const mudarPeriodo = (novoPeriodo) => {
    setSelectedPeriod(novoPeriodo);
    if (selectedStation) {
      carregarHistorico(selectedStation.cod_estacao, novoPeriodo);
    }
  };

  // 4. Inicialização do Mapa Leaflet
  useEffect(() => {
    verificarSessao().then(() => carregarEstacoes());

    if (currentView === 'map' && !leafletMap.current && mapRef.current) {
      const map = L.map(mapRef.current, {
        center: [-18.7369, -47.5011], // Monte Carmelo centralizado
        zoom: 13,
        zoomControl: false,
        attributionControl: false
      });

      L.control.zoom({ position: 'bottomright' }).addTo(map);

      const satLayer = L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        { maxZoom: 19 }
      );

      const darkLayer = L.tileLayer(
        'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        { maxZoom: 19 }
      );

      satLayer.addTo(map);
      baseLayers.current = { sat: satLayer, dark: darkLayer };

      const group = L.layerGroup().addTo(map);
      markersGroup.current = group;
      leafletMap.current = map;

      map.on('click', (e) => {
        setEditForm(prev => ({
          ...prev,
          latitude: parseFloat(e.latlng.lat.toFixed(6)),
          longitude: parseFloat(e.latlng.lng.toFixed(6))
        }));
      });
    }

    // Conexão WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => setWsConnected(false);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'NOVA_LEITURA') {
          carregarEstacoes();
          if (selectedStation && msg.data.cod_estacao === selectedStation.cod_estacao) {
            carregarHistorico(selectedStation.cod_estacao);
            setSelectedStation(prev => ({ ...prev, ...msg.data }));
          }
        }
      } catch (e) {
        console.error(e);
      }
    };

    return () => ws.close();
  }, [currentView]);

  // 5. Renderizar Marcadores no Mapa com Ícones e Badges
  useEffect(() => {
    if (!leafletMap.current || !markersGroup.current || currentView !== 'map') return;

    markersGroup.current.clearLayers();

    const filtered = estacoes.filter(st => {
      if (statusFilter !== 'ALL' && st.status !== statusFilter) return false;
      if (visibilityFilter === 'PUBLICA' && st.visibilidade !== 'PUBLICA') return false;
      if (visibilityFilter === 'PRIVADA' && st.visibilidade !== 'PRIVADA') return false;
      if (visibilityFilter === 'PENDENTE' && st.status_financeiro !== 'PENDENTE') return false;
      return true;
    });

    filtered.forEach(st => {
      if (!st.latitude || !st.longitude) return;

      const isOnline = st.status === 'ONLINE';
      const isSleep = st.status === 'DEEP_SLEEP';
      const statusColor = isOnline ? '#22c55e' : (isSleep ? '#f59e0b' : '#ef4444');

      // Pin personalizado com suporte a Privada e Inadimplente
      const isPrivada = st.visibilidade === 'PRIVADA';
      const isPendente = st.status_financeiro === 'PENDENTE';

      let pinBg = isOnline ? '#0ea5e9' : '#0284c7';
      if (isPendente) pinBg = '#f59e0b'; // Laranja de pendência financeira
      if (isPrivada && !st.acesso_bloqueado) pinBg = '#10b981'; // Verde especial para privadas autorizadas

      const badgeTop = isPendente ? '⚠️' : (isPrivada ? '🔒' : '');

      const customIcon = L.divIcon({
        className: 'custom-pin-wrapper',
        html: `
          <div class="custom-pin-container">
            <div class="pin-status-dot" style="background-color: ${statusColor};"></div>
            <div class="pin-body" style="background: ${pinBg};">
              <div class="pin-icon">
                ${isPendente ? `
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                  </svg>
                ` : (isPrivada ? `
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                  </svg>
                ` : `
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>
                  </svg>
                `)}
              </div>
            </div>
            <div style="background: rgba(10,15,13,0.9); color: #fff; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; white-space: nowrap; margin-top: 4px; border: 1px solid rgba(255,255,255,0.25); box-shadow: 0 2px 5px rgba(0,0,0,0.5); display: flex; align-items: center; gap: 3px;">
              <span>${badgeTop}</span>
              <span>${st.nome ? st.nome.split(' - ')[0] : st.cod_estacao}</span>
            </div>
          </div>
        `,
        iconSize: [40, 56],
        iconAnchor: [20, 56]
      });

      const marker = L.marker([st.latitude, st.longitude], { icon: customIcon });

      marker.on('click', () => {
        setSelectedStation(st);
        setDrawerOpen(true);
        if (!st.acesso_bloqueado) {
          carregarHistorico(st.cod_estacao);
        } else {
          setStationHistory([]);
        }
        leafletMap.current.setView([st.latitude, st.longitude], 15, { animate: true });
      });

      markersGroup.current.addLayer(marker);
    });
  }, [estacoes, statusFilter, visibilityFilter, currentView, user]);

  // Alternar Camadas
  const mudarCamada = (tipo) => {
    setActiveLayer(tipo);
    const map = leafletMap.current;
    if (!map) return;

    if (tipo === 'dark') {
      map.removeLayer(baseLayers.current.sat);
      baseLayers.current.dark.addTo(map);
    } else {
      map.removeLayer(baseLayers.current.dark);
      baseLayers.current.sat.addTo(map);
    }
  };

  const recentralizarMapa = () => {
    if (leafletMap.current) {
      leafletMap.current.setView([-18.7369, -47.5011], 13, { animate: true });
    }
  };

  // Submissão de Login / Cadastro
  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    setAuthError('');
    setAuthLoading(true);

    const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/registrar';
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authForm)
      });
      const data = await res.json();

      if (res.ok) {
        localStorage.setItem('gaia_token', data.token);
        setUser(data.user);
        setAuthModalOpen(false);
        setAuthForm({ nome: '', email: '', senha: '' });
        await carregarEstacoes();
      } else {
        setAuthError(data.error || 'Falha na autenticação.');
      }
    } catch (err) {
      setAuthError('Erro de conexão com o servidor: ' + err.message);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('gaia_token');
    setUser(null);
    carregarEstacoes();
  };

  const abrirEdicao = () => {
    if (!selectedStation) return;
    setEditForm({
      nome: selectedStation.nome || '',
      cultura: selectedStation.cultura || '',
      latitude: selectedStation.latitude || -18.73,
      longitude: selectedStation.longitude || -47.50,
      visibilidade: selectedStation.visibilidade || 'PUBLICA',
      status_financeiro: selectedStation.status_financeiro || 'ATIVO',
      api_token: selectedStation.api_token || `gaia_sec_${selectedStation.cod_estacao}_${Math.random().toString(36).substring(2, 10)}`
    });
    setEditModalOpen(true);
  };

  const salvarEdicao = async (e) => {
    e.preventDefault();
    if (!selectedStation) return;

    try {
      const res = await fetch(`/api/estacoes/${selectedStation.cod_estacao}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders()
        },
        body: JSON.stringify(editForm)
      });

      if (res.ok) {
        setEditModalOpen(false);
        const atualizadas = await carregarEstacoes();
        const atualizada = atualizadas.find(s => s.cod_estacao === selectedStation.cod_estacao);
        if (atualizada) setSelectedStation(atualizada);
      } else {
        const err = await res.json();
        alert('Erro ao salvar: ' + (err.error || 'Não autorizado'));
      }
    } catch (err) {
      alert('Erro de rede: ' + err.message);
    }
  };

  // Simular Envio
  const simularEnvio = async (cod) => {
    const targetCod = cod || (selectedStation ? selectedStation.cod_estacao : 'G00001');
    try {
      await fetch('/api/simular', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estacao: targetCod })
      });
      await carregarEstacoes();
      if (selectedStation && selectedStation.cod_estacao === targetCod) {
        carregarHistorico(targetCod);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const formatarData = (ts, iso) => {
    const d = iso ? new Date(iso) : (ts ? new Date(ts * 1000) : new Date());
    return d.toLocaleString('pt-BR');
  };

  // Ação para popular 24h de histórico contínuo
  const popularHistorico24h = async (cod) => {
    const targetCod = cod || (selectedStation ? selectedStation.cod_estacao : 'G00001');
    try {
      const res = await fetch(`/api/estacoes/${targetCod}/popular-historico`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }
      });
      if (res.ok) {
        await carregarEstacoes();
        await carregarHistorico(targetCod);
      }
    } catch (err) {
      console.error('Erro ao popular histórico:', err);
    }
  };

  // Ação para exportar CSV dos dados
  const exportarCSV = () => {
    if (!stationHistory || stationHistory.length === 0) return;
    const headers = [
      "ID", "Data_Hora", "Timestamp_UTC", "Cod_Estacao",
      "Temp_Ref_C", "Umid_Ar_Pct", "Umid_Solo_Pct", "Temp_Solo_C", "Pressao_hPa", "Luminosidade_Lux",
      "VPD_kPa", "ET0_mm", "ETc_mm", "Rad_Solar_Rs_Wm2", "PAR_umol", "Risco_Fungo", "Risco_Geada",
      "Delta_P_hPa", "Alerta_Tempestade", "ITU", "Heat_Index_HI", "Qualidade_Pct", "Heap_RAM_KB"
    ];
    const rows = stationHistory.map(h => [
      h.id,
      h.data_hora || new Date(h.timestamp_utc * 1000).toISOString(),
      h.timestamp_utc,
      h.cod_estacao,
      h.temp_ref || h.temp_dht || '',
      h.umidade || '',
      h.umidade_solo !== null ? h.umidade_solo : '',
      h.temp_solo || '',
      h.pressao || '',
      h.lux || '',
      h.vpd || '',
      h.et0 || '',
      h.etc || '',
      h.rs || '',
      h.par || '',
      h.rf || 0,
      h.rg || 0,
      h.dp || '',
      h.at ? 1 : 0,
      h.itu || '',
      h.hi || '',
      h.qualidade || 100,
      h.heap_mod || ''
    ]);
    const csvContent = "data:text/csv;charset=utf-8," + [headers.join(";"), ...rows.map(e => e.join(";"))].join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `telemetria_${selectedStation.cod_estacao}_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Eixo temporal comum adaptado ao período selecionado
  const chartLabels = stationHistory.map(h => {
    const d = h.data_hora ? new Date(h.data_hora) : new Date(h.timestamp_utc * 1000);
    if (selectedPeriod === '24h' || selectedPeriod === '1d') {
      return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }
    if (selectedPeriod === '7d') {
      const diaSemana = d.toLocaleDateString('pt-BR', { weekday: 'short' });
      return `${diaSemana.slice(0, 3)} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
    }
    if (selectedPeriod === '30d') {
      return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    }
    const mes = d.toLocaleDateString('pt-BR', { month: 'short' });
    return `${d.getDate()}/${mes.slice(0, 3)}`;
  });

  // Base options e plugins para todos os gráficos separados
  const baseGridColor = 'rgba(255, 255, 255, 0.06)';
  const baseTickColor = '#94a3b8';

  const basePlugins = {
    legend: { labels: { color: baseTickColor, font: { size: 11 }, boxWidth: 10 } },
    tooltip: {
      backgroundColor: '#0f172a',
      titleColor: '#38bdf8',
      bodyColor: '#f1f5f9',
      borderColor: '#334155',
      borderWidth: 1,
      padding: 10,
      callbacks: {
        title: (items) => {
          if (!items || !items.length) return '';
          const idx = items[0].dataIndex;
          const h = stationHistory[idx];
          if (!h) return items[0].label;
          const d = h.data_hora ? new Date(h.data_hora) : new Date(h.timestamp_utc * 1000);
          return d.toLocaleString('pt-BR');
        }
      }
    }
  };

  // 1. Gráfico Microclima (Temperatura & Umidade)
  const chartDataClima = {
    labels: chartLabels,
    datasets: [
      {
        label: 'Temp. Ar (°C)',
        data: stationHistory.map(h => h.temp_ref || h.temp_dht),
        borderColor: '#f59e0b',
        backgroundColor: 'rgba(245, 158, 11, 0.12)',
        pointBackgroundColor: '#f59e0b',
        pointRadius: 3,
        pointHoverRadius: 6,
        tension: 0.35,
        fill: true,
        yAxisID: 'y'
      },
      {
        label: 'Ponto Orvalho (°C)',
        data: stationHistory.map(h => h.ponto_orvalho),
        borderColor: '#38bdf8',
        borderDash: [4, 4],
        pointRadius: 2,
        tension: 0.35,
        yAxisID: 'y'
      },
      {
        label: 'Umid. Ar (%)',
        data: stationHistory.map(h => h.umidade),
        borderColor: '#06b6d4',
        backgroundColor: 'rgba(6, 182, 212, 0.08)',
        pointBackgroundColor: '#06b6d4',
        pointRadius: 3,
        pointHoverRadius: 6,
        tension: 0.35,
        fill: false,
        yAxisID: 'y1'
      }
    ]
  };

  const chartOptionsClima = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: basePlugins,
    scales: {
      x: { grid: { color: baseGridColor }, ticks: { color: baseTickColor, maxTicksLimit: 5, font: { size: 10 } } },
      y: {
        position: 'left',
        grid: { color: baseGridColor },
        ticks: { color: '#f59e0b', callback: v => `${v}°C` },
        title: { display: true, text: 'Temperatura (°C)', color: '#f59e0b', font: { size: 10, weight: 'bold' } }
      },
      y1: {
        position: 'right',
        grid: { drawOnChartArea: false },
        ticks: { color: '#06b6d4', callback: v => `${v}%` },
        min: 0,
        max: 100,
        title: { display: true, text: 'Umidade (%)', color: '#06b6d4', font: { size: 10, weight: 'bold' } }
      }
    }
  };

  // 2. Gráfico Balanço Hídrico & Transpiração (VPD, ET0 e ETc)
  const chartDataAgro = {
    labels: chartLabels,
    datasets: [
      {
        label: 'VPD - Déficit de Vapor (kPa)',
        data: stationHistory.map(h => h.vpd),
        borderColor: '#10b981',
        backgroundColor: 'rgba(16, 185, 129, 0.15)',
        pointBackgroundColor: '#10b981',
        pointRadius: 3,
        tension: 0.35,
        fill: true,
        yAxisID: 'y'
      },
      {
        label: 'ET₀ FAO-56 (mm)',
        data: stationHistory.map(h => h.et0),
        borderColor: '#3b82f6',
        pointBackgroundColor: '#3b82f6',
        pointRadius: 3,
        tension: 0.35,
        yAxisID: 'y1'
      },
      {
        label: 'ETc Cultura (mm)',
        data: stationHistory.map(h => h.etc),
        borderColor: '#a855f7',
        borderDash: [3, 3],
        pointBackgroundColor: '#a855f7',
        pointRadius: 3,
        tension: 0.35,
        yAxisID: 'y1'
      }
    ]
  };

  const chartOptionsAgro = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: basePlugins,
    scales: {
      x: { grid: { color: baseGridColor }, ticks: { color: baseTickColor, maxTicksLimit: 5, font: { size: 10 } } },
      y: {
        position: 'left',
        grid: { color: baseGridColor },
        ticks: { color: '#10b981', callback: v => `${v} kPa` },
        title: { display: true, text: 'VPD (kPa)', color: '#10b981', font: { size: 10, weight: 'bold' } }
      },
      y1: {
        position: 'right',
        grid: { drawOnChartArea: false },
        ticks: { color: '#3b82f6', callback: v => `${v} mm` },
        title: { display: true, text: 'Evapotranspiração (mm)', color: '#3b82f6', font: { size: 10, weight: 'bold' } }
      }
    }
  };

  // 3. Gráfico Radiação Solar & Atividade Fotossintética (Rs e PAR)
  const chartDataSolar = {
    labels: chartLabels,
    datasets: [
      {
        label: 'Radiação Global Rs (W/m²)',
        data: stationHistory.map(h => h.rs),
        borderColor: '#eab308',
        backgroundColor: 'rgba(234, 179, 8, 0.15)',
        pointBackgroundColor: '#eab308',
        pointRadius: 3,
        tension: 0.35,
        fill: true,
        yAxisID: 'y'
      },
      {
        label: 'Radiação PAR (µmol/m²/s)',
        data: stationHistory.map(h => h.par),
        borderColor: '#2dd4bf',
        pointBackgroundColor: '#2dd4bf',
        pointRadius: 3,
        tension: 0.35,
        yAxisID: 'y1'
      }
    ]
  };

  const chartOptionsSolar = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: basePlugins,
    scales: {
      x: { grid: { color: baseGridColor }, ticks: { color: baseTickColor, maxTicksLimit: 5, font: { size: 10 } } },
      y: {
        position: 'left',
        grid: { color: baseGridColor },
        ticks: { color: '#eab308', callback: v => `${v} W` },
        title: { display: true, text: 'Radiação Rs (W/m²)', color: '#eab308', font: { size: 10, weight: 'bold' } }
      },
      y1: {
        position: 'right',
        grid: { drawOnChartArea: false },
        ticks: { color: '#2dd4bf', callback: v => `${v}` },
        title: { display: true, text: 'PAR (µmol/m²/s)', color: '#2dd4bf', font: { size: 10, weight: 'bold' } }
      }
    }
  };

  // 4. Gráfico Solo (Umidade & Temperatura)
  const chartDataSolo = {
    labels: chartLabels,
    datasets: [
      {
        label: 'Umidade do Solo (%)',
        data: stationHistory.map(h => h.umidade_solo),
        borderColor: '#10b981',
        backgroundColor: 'rgba(16, 185, 129, 0.18)',
        pointBackgroundColor: '#10b981',
        pointRadius: 3,
        tension: 0.35,
        fill: true,
        yAxisID: 'y'
      },
      {
        label: 'Temperatura Solo (°C)',
        data: stationHistory.map(h => h.temp_solo),
        borderColor: '#818cf8',
        pointBackgroundColor: '#818cf8',
        pointRadius: 3,
        tension: 0.35,
        yAxisID: 'y1'
      }
    ]
  };

  const chartOptionsSolo = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: basePlugins,
    scales: {
      x: { grid: { color: baseGridColor }, ticks: { color: baseTickColor, maxTicksLimit: 5, font: { size: 10 } } },
      y: {
        position: 'left',
        grid: { color: baseGridColor },
        ticks: { color: '#10b981', callback: v => `${v}%` },
        min: 0,
        max: 100,
        title: { display: true, text: 'Umidade Solo (%)', color: '#10b981', font: { size: 10, weight: 'bold' } }
      },
      y1: {
        position: 'right',
        grid: { drawOnChartArea: false },
        ticks: { color: '#818cf8', callback: v => `${v}°C` },
        title: { display: true, text: 'Temp Solo (°C)', color: '#818cf8', font: { size: 10, weight: 'bold' } }
      }
    }
  };

  // 5. Gráfico Barometria & Variação ΔP
  const chartDataBaro = {
    labels: chartLabels,
    datasets: [
      {
        label: 'Pressão Atmosférica (hPa)',
        data: stationHistory.map(h => h.pressao),
        borderColor: '#c084fc',
        backgroundColor: 'rgba(192, 132, 252, 0.12)',
        pointBackgroundColor: '#c084fc',
        pointRadius: 3,
        tension: 0.35,
        fill: true,
        yAxisID: 'y'
      },
      {
        label: 'Variação ΔP (hPa/3h)',
        data: stationHistory.map(h => h.dp),
        borderColor: '#38bdf8',
        borderDash: [3, 3],
        pointBackgroundColor: '#38bdf8',
        pointRadius: 3,
        tension: 0.35,
        yAxisID: 'y1'
      }
    ]
  };

  const chartOptionsBaro = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: basePlugins,
    scales: {
      x: { grid: { color: baseGridColor }, ticks: { color: baseTickColor, maxTicksLimit: 5, font: { size: 10 } } },
      y: {
        position: 'left',
        grid: { color: baseGridColor },
        ticks: { color: '#c084fc', callback: v => `${v} hPa` },
        title: { display: true, text: 'Pressão (hPa)', color: '#c084fc', font: { size: 10, weight: 'bold' } }
      },
      y1: {
        position: 'right',
        grid: { drawOnChartArea: false },
        ticks: { color: '#38bdf8', callback: v => `${v > 0 ? '+' : ''}${v}` },
        title: { display: true, text: 'ΔP (hPa/3h)', color: '#38bdf8', font: { size: 10, weight: 'bold' } }
      }
    }
  };

  // 6. Gráfico Bioclimatologia & Estresse Térmico (ITU e Heat Index)
  const chartDataBioclima = {
    labels: chartLabels,
    datasets: [
      {
        label: 'Índice ITU (Conforto Animal)',
        data: stationHistory.map(h => h.itu),
        borderColor: '#f43f5e',
        backgroundColor: 'rgba(244, 63, 94, 0.15)',
        pointBackgroundColor: '#f43f5e',
        pointRadius: 3,
        tension: 0.35,
        fill: true,
        yAxisID: 'y'
      },
      {
        label: 'Sensação Térmica HI (°C)',
        data: stationHistory.map(h => h.hi),
        borderColor: '#fb923c',
        pointBackgroundColor: '#fb923c',
        pointRadius: 3,
        tension: 0.35,
        yAxisID: 'y1'
      }
    ]
  };

  const chartOptionsBioclima = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: basePlugins,
    scales: {
      x: { grid: { color: baseGridColor }, ticks: { color: baseTickColor, maxTicksLimit: 5, font: { size: 10 } } },
      y: {
        position: 'left',
        grid: { color: baseGridColor },
        ticks: { color: '#f43f5e', callback: v => `${v}` },
        title: { display: true, text: 'ITU (Animal)', color: '#f43f5e', font: { size: 10, weight: 'bold' } }
      },
      y1: {
        position: 'right',
        grid: { drawOnChartArea: false },
        ticks: { color: '#fb923c', callback: v => `${v}°C` },
        title: { display: true, text: 'Sensação HI (°C)', color: '#fb923c', font: { size: 10, weight: 'bold' } }
      }
    }
  };

  return (
    <div className="relative w-screen h-screen overflow-hidden flex flex-col bg-slate-950 text-slate-100">

      {/* 🧭 HEADER: LOGO GAIA & AUTENTICAÇÃO REAL (100% RESPONSIVO) */}
      <header className="h-16 bg-white border-b border-slate-200 px-3 sm:px-6 flex items-center justify-between z-30 shadow-sm shrink-0">
        {/* Lado Esquerdo: Logo Oficial do Projeto GAIA */}
        <div className="flex items-center space-x-2 sm:space-x-4 min-w-0">
          <div 
            onClick={() => setCurrentView('map')}
            className="flex items-center gap-2 sm:gap-3 cursor-pointer group min-w-0"
          >
            <img 
              src="/gaia_logo.png" 
              alt="Projeto GAIA Logo" 
              className="w-8 h-8 sm:w-10 sm:h-10 rounded-xl object-cover shadow-sm group-hover:scale-105 transition shrink-0"
            />
            <div className="leading-tight min-w-0">
              <div className="text-base sm:text-xl font-black tracking-tight text-slate-800 flex items-center gap-1 truncate">
                PROJETO <span className="text-emerald-600">GAIA</span>
              </div>
              <div className="text-[8px] sm:text-[9px] uppercase tracking-wider font-bold text-slate-500 hidden xs:block truncate">
                Monitoramento Agroclimático & IoT
              </div>
            </div>
          </div>

          <div className="hidden md:block h-6 w-[1px] bg-slate-200"></div>

          <h1 className="text-xl font-bold text-slate-700 tracking-tight hidden lg:block truncate">
            Sistema de gerenciamento
          </h1>
        </div>

        {/* Lado Direito: Ações & Perfil do Usuário */}
        <div className="flex items-center gap-1.5 sm:gap-3 shrink-0">
          {/* Status WebSocket (Desktop / Tablet) */}
          <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
            <span className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`}></span>
            <span>{wsConnected ? 'Rede Online' : 'Conectando'}</span>
          </div>

          {/* Status WebSocket (Mobile Compacto) */}
          <div 
            className="sm:hidden flex items-center justify-center w-7 h-7 rounded-full bg-emerald-50 border border-emerald-200" 
            title={wsConnected ? 'Rede Online' : 'Conectando'}
          >
            <span className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`}></span>
          </div>

          {/* Botão de Alternar Visualização */}
          {currentView === 'dashboard' && (
            <button
              onClick={() => setCurrentView('map')}
              className="flex items-center gap-1 sm:gap-1.5 bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold px-2.5 sm:px-3 py-1.5 sm:py-2 rounded-lg transition shadow-sm cursor-pointer"
              title="Voltar ao mapa de estações"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Voltar ao Mapa</span>
              <span className="sm:hidden">Mapa</span>
            </button>
          )}

          {/* Se estiver Logado */}
          {user ? (
            <div className="flex items-center gap-1.5 sm:gap-2.5">
              <div className="flex items-center gap-2 pl-1 sm:pl-2">
                <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-emerald-100 text-emerald-800 font-bold flex items-center justify-center text-xs border border-emerald-300">
                  {user.nome ? user.nome.charAt(0).toUpperCase() : 'U'}
                </div>
                <div className="hidden md:block text-left text-xs leading-tight">
                  <div className="font-bold text-slate-800 flex items-center gap-1.5">
                    <span>{user.nome.split(' ')[0]}</span>
                    {user.role === 'ADMIN' && (
                      <span className="text-[10px] bg-amber-100 text-amber-800 border border-amber-300 px-1.5 py-0.2 rounded font-black">
                        MASTER
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-slate-500">{user.email}</div>
                </div>
              </div>

              <button
                onClick={handleLogout}
                title="Sair da Conta"
                className="p-1.5 sm:p-2 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition cursor-pointer"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ) : (
            /* Se NÃO estiver logado */
            <div className="flex items-center gap-1 sm:gap-2">
              <button
                onClick={() => { setAuthMode('login'); setAuthModalOpen(true); }}
                className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs sm:text-sm font-semibold px-2.5 sm:px-4 py-1.5 rounded-lg transition shadow-sm cursor-pointer"
              >
                Login
              </button>
              <button
                onClick={() => { setAuthMode('register'); setAuthModalOpen(true); }}
                className="bg-slate-100 hover:bg-slate-200 border border-slate-300 text-slate-700 text-xs sm:text-sm font-semibold px-2.5 sm:px-4 py-1.5 rounded-lg transition cursor-pointer"
              >
                Registrar
              </button>
            </div>
          )}
        </div>
      </header>

      {/* 🗺️ VIEW 1: MAPA EM TELA CHEIA (HOME PAGE) */}
      {currentView === 'map' && (
        <div className="relative flex-1 w-full h-full">
          <div ref={mapRef} className="w-full h-full z-10" />

          {/* 🔘 BOTÃO FLUTUANTE DE "FILTROS" (RESPONSIVO) */}
          <div className="absolute top-3 left-3 sm:top-4 sm:left-4 z-20">
            <button
              onClick={() => setFilterOpen(!filterOpen)}
              className="flex items-center gap-2 px-3 py-2 sm:px-3.5 sm:py-2 bg-slate-900/90 hover:bg-slate-900 backdrop-blur-md text-white rounded-lg shadow-xl border border-slate-700 text-xs font-semibold transition cursor-pointer"
            >
              <Filter className="w-3.5 h-3.5 text-teal-400" />
              <span>Filtros</span>
            </button>

            {filterOpen && (
              <div className="mt-2 w-[calc(100vw-28px)] max-w-xs bg-slate-900/95 backdrop-blur-xl border border-slate-700 rounded-xl p-3.5 sm:p-4 shadow-2xl space-y-3.5 sm:space-y-4">
                <div className="flex justify-between items-center pb-2 border-b border-slate-800">
                  <span className="text-xs font-bold text-white uppercase tracking-wider">Filtros do Mapa</span>
                  <button onClick={() => setFilterOpen(false)} className="text-slate-400 hover:text-white cursor-pointer p-1">
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Filtro por Tipo de Estação */}
                <div>
                  <label className="text-[11px] font-semibold text-slate-400 block mb-1.5">Tipo de Estação</label>
                  <div className="grid grid-cols-2 gap-1.5">
                    {[
                      { id: 'ALL', label: 'Todas' },
                      { id: 'PUBLICA', label: 'Públicas' },
                      { id: 'PRIVADA', label: 'Privadas 🔒' },
                      { id: 'PENDENTE', label: 'Pendentes ⚠️' }
                    ].map(item => (
                      <button
                        key={item.id}
                        onClick={() => setVisibilityFilter(item.id)}
                        className={`px-2 py-1.5 rounded-md text-xs font-medium transition cursor-pointer ${
                          visibilityFilter === item.id ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                        }`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Filtro de Status de Transmissão */}
                <div>
                  <label className="text-[11px] font-semibold text-slate-400 block mb-1.5">Status de Conexão</label>
                  <div className="grid grid-cols-2 gap-1.5">
                    {[
                      { id: 'ALL', label: 'Todos' },
                      { id: 'ONLINE', label: 'Online' },
                      { id: 'DEEP_SLEEP', label: 'Deep Sleep' },
                      { id: 'OFFLINE', label: 'Offline' }
                    ].map(item => (
                      <button
                        key={item.id}
                        onClick={() => setStatusFilter(item.id)}
                        className={`px-2 py-1.5 rounded-md text-xs font-medium transition cursor-pointer ${
                          statusFilter === item.id ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                        }`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Camada do Mapa */}
                <div>
                  <label className="text-[11px] font-semibold text-slate-400 block mb-1.5">Camada de Fundo</label>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      onClick={() => mudarCamada('sat')}
                      className={`px-2 py-1.5 rounded-md text-xs font-medium transition cursor-pointer ${
                        activeLayer === 'sat' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                      }`}
                    >
                      Satélite Real
                    </button>
                    <button
                      onClick={() => mudarCamada('dark')}
                      className={`px-2 py-1.5 rounded-md text-xs font-medium transition cursor-pointer ${
                        activeLayer === 'dark' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                      }`}
                    >
                      Modo Noturno
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 🎯 BOTÃO FLUTUANTE DE "RECENTRALIZAR" */}
          <div className="absolute bottom-5 left-3 sm:bottom-6 sm:left-4 z-20">
            <button
              onClick={recentralizarMapa}
              className="flex items-center gap-1.5 sm:gap-2 px-3 py-2 sm:px-3.5 sm:py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg shadow-xl text-xs font-semibold transition cursor-pointer"
            >
              <Navigation className="w-3.5 h-3.5" />
              <span>Recentralizar</span>
            </button>
          </div>

          {/* 🪟 DRAWER LATERAL: VISUALIZAÇÃO RÁPIDA COM SUPORTE A RESTRIÇÃO (100% RESPONSIVO) */}
          {drawerOpen && selectedStation && (
            <div className="absolute top-0 right-0 bottom-0 w-full sm:w-[420px] max-w-full bg-white text-slate-800 shadow-2xl z-30 flex flex-col border-l border-slate-200 transition-all">
              
              {/* Topo do Drawer */}
              <div className="p-4 sm:p-5 border-b border-slate-100 shrink-0">
                <div className="flex justify-between items-center mb-2">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[10px] sm:text-[11px] font-bold px-2 py-0.5 rounded bg-slate-100 text-slate-700 uppercase tracking-wider">
                      ESTAÇÃO
                    </span>
                    
                    {/* Badge de Visibilidade */}
                    {selectedStation.visibilidade === 'PRIVADA' ? (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-purple-100 text-purple-800 border border-purple-200 flex items-center gap-1">
                        <Lock className="w-2.5 h-2.5" /> Privada
                      </span>
                    ) : (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 flex items-center gap-1">
                        <Eye className="w-2.5 h-2.5" /> Pública
                      </span>
                    )}

                    {/* Badge Financeiro */}
                    {selectedStation.status_financeiro === 'PENDENTE' && (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300 flex items-center gap-1">
                        <AlertTriangle className="w-2.5 h-2.5" /> Mensalidade Pendente
                      </span>
                    )}

                    {/* Status de Conexão */}
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1 ${
                      selectedStation.status === 'ONLINE'
                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                        : (selectedStation.status === 'DEEP_SLEEP' ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-red-50 text-red-700')
                    }`}>
                      <Check className="w-3 h-3 text-emerald-600" />
                      {selectedStation.status === 'ONLINE' ? 'Ativo' : selectedStation.status}
                    </span>
                  </div>

                  <button
                    onClick={() => setDrawerOpen(false)}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition cursor-pointer"
                    title="Fechar painel"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <div className="flex justify-between items-start">
                  <div className="min-w-0 pr-2">
                    <h2 className="text-lg sm:text-xl font-bold text-slate-900 leading-snug truncate">
                      {selectedStation.nome || `Estação ${selectedStation.cod_estacao}`}
                    </h2>
                    <p className="text-xs text-slate-500 mt-0.5 truncate">
                      ID: <span className="font-mono font-medium">{selectedStation.cod_estacao}</span> &bull; {selectedStation.cultura || 'Lavouras Gerais'}
                    </p>
                  </div>

                  {/* Botão de Edição (Se Master ou Dono) */}
                  {(user && (user.role === 'ADMIN' || !selectedStation.acesso_bloqueado)) && (
                    <button
                      onClick={abrirEdicao}
                      title="Configurar Estação"
                      className="p-2 rounded-lg text-slate-400 hover:text-emerald-700 hover:bg-emerald-50 transition cursor-pointer shrink-0"
                    >
                      <Edit3 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>

              {/* Corpo com Informações Rápidas de Telemetria */}
              <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-3 sm:space-y-4 text-xs">
                
                {/* Card de Localização */}
                <div className="p-2.5 sm:p-3 rounded-lg bg-slate-50 border border-slate-200/80 flex items-center gap-2 text-slate-700 font-mono text-[11px] sm:text-xs">
                  <MapPin className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-slate-400 shrink-0" />
                  <span>Local:</span>
                  <span className="font-semibold text-slate-900 truncate">
                    {selectedStation.latitude?.toFixed(5)}, {selectedStation.longitude?.toFixed(5)}
                  </span>
                </div>

                {/* 🔒 BLOQUEIO 1: ESTAÇÃO COM MENSALIDADE PENDENTE */}
                {selectedStation.acesso_bloqueado && selectedStation.motivo_bloqueio === 'MENSALIDADE_PENDENTE' ? (
                  <div className="p-4 sm:p-5 rounded-xl bg-amber-50/70 border border-amber-200 text-center space-y-3">
                    <div className="w-12 h-12 rounded-full bg-amber-100 text-amber-700 mx-auto flex items-center justify-center">
                      <CreditCard className="w-6 h-6" />
                    </div>
                    <div>
                      <h4 className="font-bold text-amber-900 text-sm">Assinatura / Mensalidade Pendente</h4>
                      <p className="text-xs text-amber-700 mt-1 leading-relaxed">
                        A transmissão dos dados de telemetria desta estação está temporariamente suspensa por pendência financeira.
                      </p>
                    </div>
                    <div className="text-[11px] text-slate-500 pt-1">
                      Para regularizar a mensalidade ou obter suporte, contate o administrador da plataforma.
                    </div>
                  </div>
                ) : selectedStation.acesso_bloqueado && selectedStation.motivo_bloqueio === 'ESTACAO_PRIVADA' ? (
                  /* 🔒 BLOQUEIO 2: ESTAÇÃO PRIVADA SEM PERMISSÃO */
                  <div className="p-4 sm:p-5 rounded-xl bg-slate-50 border border-slate-200 text-center space-y-3">
                    <div className="w-12 h-12 rounded-full bg-purple-100 text-purple-700 mx-auto flex items-center justify-center">
                      <Lock className="w-6 h-6" />
                    </div>
                    <div>
                      <h4 className="font-bold text-slate-900 text-sm">Estação de Monitoramento Privada</h4>
                      <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                        Os dados climáticos desta estação pertencem a um produtor particular e requerem autorização para visualização.
                      </p>
                    </div>
                    <button
                      onClick={() => { setAuthMode('login'); setAuthModalOpen(true); }}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs transition cursor-pointer shadow-sm"
                    >
                      <User className="w-3.5 h-3.5" />
                      <span>Fazer Login para Desbloquear</span>
                    </button>
                  </div>
                ) : (
                  /* 🔓 DADOS LIBERADOS (PÚBLICA OU USUÁRIO AUTORIZADO / MASTER) */
                  <>
                    <div className="border border-slate-200 rounded-xl p-3.5 sm:p-4 bg-white shadow-sm space-y-3">
                      <div className="flex justify-between items-center text-slate-600 pb-2 border-b border-slate-100">
                        <div className="flex items-center gap-2 font-bold text-slate-800">
                          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
                          <span>Telemetria Atual</span>
                        </div>
                        <span className="text-[10px] sm:text-[11px] text-slate-400 font-mono">
                          {formatarData(selectedStation.timestamp_utc, selectedStation.data_hora)}
                        </span>
                      </div>

                      {/* Grid 2x2 Responsivo */}
                      <div className="grid grid-cols-2 gap-2 sm:gap-3">
                        <div className="p-2.5 sm:p-3 rounded-lg bg-slate-50 border border-slate-100">
                          <div className="flex items-center gap-1.5 text-slate-500 mb-1">
                            <Thermometer className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                            <span className="text-[11px] truncate">Temp. Ar</span>
                          </div>
                          <div className="text-lg sm:text-xl font-black text-slate-900">
                            {selectedStation.temp_ref || selectedStation.temp_dht || '--'} <span className="text-xs font-normal text-slate-500">°C</span>
                          </div>
                        </div>

                        <div className="p-2.5 sm:p-3 rounded-lg bg-slate-50 border border-slate-100">
                          <div className="flex items-center gap-1.5 text-slate-500 mb-1">
                            <CloudRain className="w-3.5 h-3.5 text-cyan-500 shrink-0" />
                            <span className="text-[11px] truncate">Umidade</span>
                          </div>
                          <div className="text-lg sm:text-xl font-black text-slate-900">
                            {selectedStation.umidade || '--'} <span className="text-xs font-normal text-slate-500">%</span>
                          </div>
                        </div>

                        <div className="p-2.5 sm:p-3 rounded-lg bg-slate-50 border border-slate-100">
                          <div className="flex items-center gap-1.5 text-slate-500 mb-1">
                            <Droplets className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                            <span className="text-[11px] truncate">Umid. Solo</span>
                          </div>
                          <div className="text-lg sm:text-xl font-black text-slate-900">
                            {selectedStation.umidade_solo !== null ? selectedStation.umidade_solo : '--'} <span className="text-xs font-normal text-slate-500">%</span>
                          </div>
                        </div>

                        <div className="p-2.5 sm:p-3 rounded-lg bg-slate-50 border border-slate-100">
                          <div className="flex items-center gap-1.5 text-slate-500 mb-1">
                            <Sun className="w-3.5 h-3.5 text-yellow-500 shrink-0" />
                            <span className="text-[11px] truncate">Lux</span>
                          </div>
                          <div className="text-lg sm:text-xl font-black text-slate-900 truncate">
                            {selectedStation.lux ? Number(selectedStation.lux).toFixed(0) : '--'}
                          </div>
                        </div>
                      </div>

                      {/* Pressão Atmosférica */}
                      <div className="p-2.5 sm:p-3 rounded-lg bg-slate-50 border border-slate-100 flex justify-between items-center">
                        <div className="flex items-center gap-1.5 text-slate-500">
                          <Compass className="w-3.5 h-3.5 text-purple-500 shrink-0" />
                          <span className="text-[11px]">Pressão Atmosférica</span>
                        </div>
                        <div className="text-sm sm:text-base font-bold text-slate-900">
                          {selectedStation.pressao || '--'} <span className="text-xs font-normal text-slate-500">hPa</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 text-[11px] text-slate-400 px-1">
                      <Clock className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <span className="truncate">Última leitura: {formatarData(selectedStation.timestamp_utc, selectedStation.data_hora)}</span>
                    </div>
                  </>
                )}

              </div>

              {/* Botões de Ação na Base */}
              <div className="p-3 sm:p-4 border-t border-slate-200 flex items-center gap-2 bg-slate-50 shrink-0">
                {!selectedStation.acesso_bloqueado ? (
                  <button
                    onClick={() => { setDrawerOpen(false); setCurrentView('dashboard'); carregarHistorico(selectedStation.cod_estacao); }}
                    className="flex-1 py-2.5 sm:py-3 px-3 sm:px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs sm:text-sm transition flex items-center justify-center gap-2 shadow-sm cursor-pointer"
                  >
                    <TrendingUp className="w-4 h-4" />
                    <span>Ver Dashboard</span>
                  </button>
                ) : (
                  <button
                    disabled
                    className="flex-1 py-2.5 sm:py-3 px-3 sm:px-4 rounded-xl bg-slate-300 text-slate-500 font-bold text-xs sm:text-sm cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    <Lock className="w-4 h-4" />
                    <span>Dados Bloqueados</span>
                  </button>
                )}
                <button
                  onClick={() => setDrawerOpen(false)}
                  className="py-2.5 sm:py-3 px-3 sm:px-4 rounded-xl border border-slate-200 bg-white hover:bg-slate-100 text-slate-700 font-semibold text-xs sm:text-sm transition cursor-pointer"
                >
                  Fechar
                </button>
              </div>

            </div>
          )}
        </div>
      )}

      {/* 📊 VIEW 2: DASHBOARD COMPLETO DA ESTAÇÃO COM GRÁFICOS SEPARADOS E NOVAS INFORMAÇÕES */}
      {currentView === 'dashboard' && selectedStation && (
        <main className="flex-1 w-full overflow-y-auto bg-slate-950 p-3 sm:p-5 lg:p-8 space-y-4 sm:space-y-6">
          
          {/* 1. Top Banner de Navegação e Ações (100% RESPONSIVO) */}
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 pb-4 border-b border-slate-800">
            <div className="min-w-0">
              <button
                onClick={() => setCurrentView('map')}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400 hover:text-emerald-300 mb-2 transition cursor-pointer"
              >
                <ArrowLeft className="w-4 h-4" />
                <span>Voltar ao Mapa das Estações</span>
              </button>
              <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                <h2 className="text-xl sm:text-2xl font-black text-white flex items-center gap-2 truncate">
                  <span>{selectedStation.nome || `Estação ${selectedStation.cod_estacao}`}</span>
                </h2>
                <span className={`text-[11px] sm:text-xs px-2 sm:px-2.5 py-0.5 rounded-full font-bold flex items-center gap-1.5 border ${
                  selectedStation.status === 'ONLINE'
                    ? 'bg-emerald-950 text-emerald-400 border-emerald-700/50'
                    : 'bg-amber-950 text-amber-400 border-amber-700/50'
                }`}>
                  <span className={`w-2 h-2 rounded-full ${selectedStation.status === 'ONLINE' ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`}></span>
                  {selectedStation.status === 'ONLINE' ? 'ONLINE (Ativo)' : 'DEEP SLEEP'}
                </span>
                {selectedStation.visibilidade === 'PRIVADA' ? (
                  <span className="text-[11px] sm:text-xs px-2 sm:px-2.5 py-0.5 rounded-full bg-purple-950 text-purple-300 border border-purple-800/50 flex items-center gap-1">
                    <Lock className="w-3 h-3" /> Privada
                  </span>
                ) : (
                  <span className="text-[11px] sm:text-xs px-2 sm:px-2.5 py-0.5 rounded-full bg-blue-950 text-blue-300 border border-blue-800/50 flex items-center gap-1">
                    <Eye className="w-3 h-3" /> Pública
                  </span>
                )}
                <span className="text-[11px] sm:text-xs px-2 sm:px-2.5 py-0.5 rounded-full bg-slate-800 text-slate-300 font-mono">
                  ID: {selectedStation.cod_estacao}
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-1.5 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2">
                <span>Cultura: <strong className="text-emerald-300 font-semibold">{selectedStation.cultura || 'Agricultura Geral'}</strong></span>
                <span className="hidden sm:inline">&bull;</span>
                <span>Coordenadas: <strong className="text-slate-300 font-mono">{selectedStation.latitude?.toFixed(5)}, {selectedStation.longitude?.toFixed(5)}</strong></span>
                <span className="hidden sm:inline">&bull;</span>
                <span>Última Leitura: <strong className="text-slate-200">{formatarData(selectedStation.timestamp_utc, selectedStation.data_hora)}</strong></span>
              </p>
            </div>

            {/* Grid 2x2 no Mobile / Barra Linear no Desktop */}
            <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-2 w-full lg:w-auto shrink-0">
              <button
                onClick={() => popularHistorico24h(selectedStation.cod_estacao)}
                className="flex items-center justify-center gap-1.5 bg-indigo-600/80 hover:bg-indigo-600 border border-indigo-500/50 text-white text-xs font-semibold px-2.5 sm:px-3 py-2 rounded-lg transition shadow-sm cursor-pointer truncate"
                title="Gera telemetrias cobrindo 24h, 7d, 30d, 6 meses e 1 ano"
              >
                <Database className="w-3.5 h-3.5 text-indigo-200 shrink-0" />
                <span className="truncate">Popular (1 Ano)</span>
              </button>
              <button
                onClick={() => simularEnvio(selectedStation.cod_estacao)}
                className="flex items-center justify-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold px-2.5 sm:px-3 py-2 rounded-lg transition shadow-sm cursor-pointer truncate"
                title="Gera e envia uma leitura simulada imediata"
              >
                <Send className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">Simular Envio</span>
              </button>
              <button
                onClick={exportarCSV}
                className="flex items-center justify-center gap-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-semibold px-2.5 sm:px-3 py-2 rounded-lg transition cursor-pointer truncate"
                title="Baixar histórico completo em planilha CSV"
              >
                <Download className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span className="truncate">Exportar CSV</span>
              </button>
              <button
                onClick={() => carregarHistorico(selectedStation.cod_estacao)}
                className="flex items-center justify-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 transition border border-slate-700 px-2.5 sm:px-3 py-2 rounded-lg text-xs font-semibold cursor-pointer truncate"
                title="Atualizar Dados"
              >
                <RefreshCw className="w-3.5 h-3.5 shrink-0" />
                <span className="sm:hidden truncate">Atualizar</span>
              </button>
            </div>
          </div>

          {/* 2. Barra de Diagnóstico Rápido e Alertas Agroclimáticos */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {/* Alerta 1: Tendência Barométrica & Tempestade */}
            <div className={`p-3 rounded-xl border flex items-center gap-3 transition ${
              selectedStation.at || (selectedStation.dp !== null && selectedStation.dp <= -1.5)
                ? 'bg-rose-950/40 border-rose-800/60 text-rose-300'
                : 'bg-slate-900/80 border-slate-800 text-slate-300'
            }`}>
              <div className={`p-2 rounded-lg ${
                selectedStation.at || (selectedStation.dp !== null && selectedStation.dp <= -1.5)
                  ? 'bg-rose-900/60 text-rose-300 animate-pulse'
                  : 'bg-slate-800 text-purple-400'
              }`}>
                <Compass className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Tendência Barométrica</div>
                <div className="text-xs font-bold truncate">
                  {selectedStation.at || (selectedStation.dp !== null && selectedStation.dp <= -1.5)
                    ? `⚡ Queda Brusca (${selectedStation.dp || -2.0} hPa) - Alerta Tempestade`
                    : `Estável (${selectedStation.pressao || '--'} hPa, ΔP: ${selectedStation.dp || 0} hPa)`}
                </div>
              </div>
            </div>

            {/* Alerta 2: Fitossanidade & Risco de Fungos */}
            <div className={`p-3 rounded-xl border flex items-center gap-3 transition ${
              selectedStation.rf === 2
                ? 'bg-rose-950/40 border-rose-800/60 text-rose-300'
                : selectedStation.rf === 1
                ? 'bg-amber-950/40 border-amber-800/60 text-amber-300'
                : 'bg-slate-900/80 border-slate-800 text-slate-300'
            }`}>
              <div className={`p-2 rounded-lg ${
                selectedStation.rf === 2 ? 'bg-rose-900/60 text-rose-300 animate-pulse' : (selectedStation.rf === 1 ? 'bg-amber-900/60 text-amber-400' : 'bg-slate-800 text-emerald-400')
              }`}>
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Risco Fúngico (Esporulação)</div>
                <div className="text-xs font-bold truncate">
                  {selectedStation.rf === 2 ? '⚠️ ALTO RISCO (Folhas Molhadas)' : (selectedStation.rf === 1 ? 'Risco Moderado (Atenção)' : '✅ Baixo Risco (Folhas Secas)')}
                </div>
              </div>
            </div>

            {/* Alerta 3: Risco de Geada */}
            <div className={`p-3 rounded-xl border flex items-center gap-3 transition ${
              selectedStation.rg === 2
                ? 'bg-purple-950/40 border-purple-800/60 text-purple-300'
                : selectedStation.rg === 1
                ? 'bg-blue-950/40 border-blue-800/60 text-blue-300'
                : 'bg-slate-900/80 border-slate-800 text-slate-300'
            }`}>
              <div className={`p-2 rounded-lg ${
                selectedStation.rg === 2 ? 'bg-purple-900/60 text-purple-300' : 'bg-slate-800 text-cyan-400'
              }`}>
                <Wind className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Previsão de Geada</div>
                <div className="text-xs font-bold truncate">
                  {selectedStation.rg === 2 ? '🚨 PERIGO: GEADA NEGRA' : (selectedStation.rg === 1 ? '❄️ Risco de Geada Branca' : '☀️ Sem Risco de Geada')}
                </div>
              </div>
            </div>

            {/* Alerta 4: Conforto Animal & ITU */}
            <div className={`p-3 rounded-xl border flex items-center gap-3 transition ${
              selectedStation.itu >= 79
                ? 'bg-rose-950/40 border-rose-800/60 text-rose-300'
                : selectedStation.itu >= 72
                ? 'bg-amber-950/40 border-amber-800/60 text-amber-300'
                : 'bg-slate-900/80 border-slate-800 text-slate-300'
            }`}>
              <div className={`p-2 rounded-lg ${
                selectedStation.itu >= 79 ? 'bg-rose-900/60 text-rose-300 animate-pulse' : (selectedStation.itu >= 72 ? 'bg-amber-900/60 text-amber-400' : 'bg-slate-800 text-teal-400')
              }`}>
                <Thermometer className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Bioclimatologia (ITU)</div>
                <div className="text-xs font-bold truncate">
                  {selectedStation.itu ? (
                    selectedStation.itu >= 79
                      ? `🚨 Crítico: ITU ${selectedStation.itu} (Estresse)`
                      : selectedStation.itu >= 72
                      ? `⚠️ Alerta: ITU ${selectedStation.itu}`
                      : `✅ Conforto Pleno: ITU ${selectedStation.itu}`
                  ) : 'Calculando...'}
                </div>
              </div>
            </div>
          </div>

          {/* 3. Cards de Métricas Agroclimáticas Principais */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            
            {/* Card 1: Microclima e Temperatura do Ar */}
            <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800 flex flex-col justify-between shadow-sm">
              <div className="flex justify-between items-start">
                <div>
                  <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Temperatura & Umidade do Ar</span>
                  <div className="flex items-baseline gap-2 mt-1">
                    <span className="text-3xl font-black text-amber-400">
                      {selectedStation.temp_ref || selectedStation.temp_dht || '--'}
                    </span>
                    <span className="text-sm font-semibold text-slate-400">°C</span>
                    <span className="text-xs text-slate-500 font-mono">/</span>
                    <span className="text-2xl font-black text-cyan-400">
                      {selectedStation.umidade || '--'}%
                    </span>
                  </div>
                </div>
                <div className="p-2 rounded-xl bg-amber-950/60 border border-amber-800/40 text-amber-400">
                  <Thermometer className="w-6 h-6" />
                </div>
              </div>
              <div className="mt-4 pt-3 border-t border-slate-800 text-xs text-slate-400 flex justify-between items-center">
                <span>Ponto Orvalho: <strong className="text-cyan-300 font-mono">{selectedStation.ponto_orvalho || '--'} °C</strong></span>
                <span>Sensação (HI): <strong className="text-amber-300 font-mono">{selectedStation.hi || '--'} °C</strong></span>
              </div>
            </div>

            {/* Card 2: VPD (Déficit de Pressão de Vapor) */}
            <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800 flex flex-col justify-between shadow-sm">
              <div className="flex justify-between items-start">
                <div>
                  <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Déficit Pressão Vapor (VPD)</span>
                  <div className="flex items-baseline gap-2 mt-1">
                    <span className="text-3xl font-black text-emerald-400">
                      {selectedStation.vpd !== null && selectedStation.vpd !== undefined ? selectedStation.vpd : '--'}
                    </span>
                    <span className="text-sm font-semibold text-slate-400">kPa</span>
                  </div>
                </div>
                <div className="p-2 rounded-xl bg-emerald-950/60 border border-emerald-800/40 text-emerald-400">
                  <Gauge className="w-6 h-6" />
                </div>
              </div>
              <div className="mt-4 pt-3 border-t border-slate-800 text-xs">
                {parseFloat(selectedStation.vpd) < 0.4 ? (
                  <div className="p-1.5 rounded-lg bg-blue-950/60 text-blue-300 border border-blue-800/40 flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-blue-400 shrink-0"></span>
                    <span>Saturação / Baixa Transpiração (Risco de Fungos)</span>
                  </div>
                ) : parseFloat(selectedStation.vpd) <= 1.25 ? (
                  <div className="p-1.5 rounded-lg bg-emerald-950/60 text-emerald-300 border border-emerald-800/40 flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0"></span>
                    <span>Faixa Ótima: Transpiração e absorção equilibradas</span>
                  </div>
                ) : parseFloat(selectedStation.vpd) <= 1.6 ? (
                  <div className="p-1.5 rounded-lg bg-amber-950/60 text-amber-300 border border-amber-800/40 flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0"></span>
                    <span>Transpiração Acelerada (Aumentar irrigação)</span>
                  </div>
                ) : (
                  <div className="p-1.5 rounded-lg bg-rose-950/60 text-rose-300 border border-rose-800/40 flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-rose-400 shrink-0"></span>
                    <span>Estresse Hídrico Severo! Fechamento estomático</span>
                  </div>
                )}
              </div>
            </div>

            {/* Card 3: Manejo Hídrico e Evapotranspiração (ET0 e ETc) */}
            <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800 flex flex-col justify-between shadow-sm">
              <div className="flex justify-between items-start">
                <div>
                  <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Demanda Hídrica (ET₀ & ETc)</span>
                  <div className="flex items-baseline gap-2 mt-1">
                    <span className="text-3xl font-black text-blue-400">{selectedStation.et0 || '--'}</span>
                    <span className="text-sm font-semibold text-slate-400">mm (ET₀)</span>
                    <span className="text-xs text-slate-500 font-mono">/</span>
                    <span className="text-xl font-bold text-purple-400">{selectedStation.etc || selectedStation.et0 || '--'}</span>
                    <span className="text-xs text-slate-500 font-semibold">mm (ETc)</span>
                  </div>
                </div>
                <div className="p-2 rounded-xl bg-blue-950/60 border border-blue-800/40 text-blue-400">
                  <Droplets className="w-6 h-6" />
                </div>
              </div>
              <div className="mt-4 pt-3 border-t border-slate-800 text-xs text-slate-400 flex justify-between items-center">
                <span>Chuva Acum.: <strong className="text-cyan-300 font-mono">{selectedStation.rg || 0} mm</strong></span>
                <span className={`px-2 py-0.5 rounded font-bold text-[10px] ${selectedStation.rf > 0 ? 'bg-blue-900 text-blue-200' : 'bg-slate-800 text-slate-400'}`}>
                  {selectedStation.rf > 0 ? '🌧️ Chuva Detectada' : 'Sem Chuva'}
                </span>
              </div>
            </div>

            {/* Card 4: Radiação Solar e Radiação Fotossintética (PAR) */}
            <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800 flex flex-col justify-between shadow-sm">
              <div className="flex justify-between items-start">
                <div>
                  <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Radiação Solar & PAR</span>
                  <div className="flex items-baseline gap-2 mt-1">
                    <span className="text-3xl font-black text-amber-400">{selectedStation.rs !== null && selectedStation.rs !== undefined ? selectedStation.rs : '--'}</span>
                    <span className="text-sm font-semibold text-slate-400">W/m²</span>
                  </div>
                </div>
                <div className="p-2 rounded-xl bg-amber-950/60 border border-amber-800/40 text-amber-400">
                  <Sun className="w-6 h-6" />
                </div>
              </div>
              <div className="mt-4 pt-3 border-t border-slate-800 text-xs text-slate-400 flex justify-between items-center">
                <span>PAR: <strong className="text-teal-300 font-mono">{selectedStation.par !== null && selectedStation.par !== undefined ? selectedStation.par : '--'} µmol/m²/s</strong></span>
                <span>Lux: <strong className="text-yellow-300 font-mono">{selectedStation.lux ? Number(selectedStation.lux).toLocaleString('pt-BR') : '--'} lx</strong></span>
              </div>
            </div>

            {/* Card 5: Perfil e Saúde do Solo */}
            <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800 flex flex-col justify-between shadow-sm">
              <div className="flex justify-between items-start">
                <div>
                  <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Perfil do Solo</span>
                  <div className="flex items-baseline gap-2 mt-1">
                    <span className="text-3xl font-black text-emerald-400">
                      {selectedStation.umidade_solo !== null ? selectedStation.umidade_solo : '--'}%
                    </span>
                    <span className="text-sm font-semibold text-slate-400">Umidade</span>
                  </div>
                </div>
                <div className="p-2 rounded-xl bg-emerald-950/60 border border-emerald-800/40 text-emerald-400">
                  <Sprout className="w-6 h-6" />
                </div>
              </div>
              <div className="mt-4 pt-3 border-t border-slate-800 text-xs text-slate-400 flex justify-between items-center">
                <span>Temp. Subterrânea (Solo): <strong className="text-white font-mono">{selectedStation.temp_solo || '--'} °C</strong></span>
                <span className="text-[10px] text-emerald-400 font-semibold">Sensor 1-Wire DS18B20</span>
              </div>
            </div>

            {/* Card 6: Barometria & Diagnóstico de Hardware */}
            <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800 flex flex-col justify-between shadow-sm">
              <div className="flex justify-between items-start">
                <div>
                  <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Hardware & Integridade</span>
                  <div className="flex items-baseline gap-2 mt-1">
                    <span className="text-3xl font-black text-purple-400">
                      {selectedStation.qualidade || 100}%
                    </span>
                    <span className="text-sm font-semibold text-slate-400">Integridade</span>
                  </div>
                </div>
                <div className="p-2 rounded-xl bg-purple-950/60 border border-purple-800/40 text-purple-400">
                  <Cpu className="w-6 h-6" />
                </div>
              </div>
              <div className="mt-4 pt-3 border-t border-slate-800 text-xs text-slate-400 flex justify-between items-center">
                <span>RAM Heap: <strong className="text-slate-200 font-mono">{selectedStation.heap_mod || 412} KB</strong></span>
                <span>Token: <strong className="text-emerald-400 font-mono text-[10px]">GAIA_TOKEN_2026_AGRO</strong></span>
              </div>
            </div>

          </div>

          {/* 4. SEÇÃO PRINCIPAL: GRÁFICOS SEPARADOS (GRID MODULAR DE SÉRIES TEMPORAIS - 100% RESPONSIVO) */}
          <div className="space-y-4 pt-2">
            
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 sm:gap-4 bg-slate-900/60 p-3 sm:p-4 rounded-2xl border border-slate-800">
              <div className="min-w-0">
                <h3 className="text-base sm:text-lg font-black text-white flex items-center gap-2 truncate">
                  <Activity className="w-5 h-5 text-emerald-400 shrink-0" />
                  <span>Séries Temporais e Gráficos Analíticos</span>
                </h3>
                <p className="text-xs text-slate-400 mt-0.5 flex flex-wrap items-center gap-1.5">
                  <span>Visualização independente de cada subsistema sem sobreposição.</span>
                  <span className="text-emerald-400 font-bold font-mono">({stationHistory.length} leituras no período)</span>
                </p>
              </div>

              {/* Seletor de Período Temporal (Trilho Horizontal Deslizável no Mobile) */}
              <div className="flex items-center gap-2 max-w-full overflow-x-auto no-scrollbar py-0.5">
                <div className="flex items-center gap-1 px-1 text-xs font-bold text-slate-300 shrink-0">
                  <Calendar className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span className="hidden xs:inline">Período:</span>
                </div>
                <div className="flex items-center gap-1 rounded-xl bg-slate-950/90 p-1 border border-slate-800 text-xs shadow-inner overflow-x-auto no-scrollbar shrink-0">
                  {[
                    { id: '24h', label: '24 Horas' },
                    { id: '7d', label: '1 Semana' },
                    { id: '30d', label: '1 Mês' },
                    { id: '6m', label: '6 Meses' },
                    { id: '1y', label: '1 Ano' },
                    { id: 'all', label: 'Todos os Dados' }
                  ].map((p) => (
                    <button
                      key={p.id}
                      onClick={() => mudarPeriodo(p.id)}
                      className={`px-2.5 sm:px-3 py-1.5 rounded-lg font-bold transition-all cursor-pointer whitespace-nowrap shrink-0 text-xs ${
                        selectedPeriod === p.id
                          ? 'bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/25 font-black'
                          : 'text-slate-300 hover:text-white hover:bg-slate-800/80'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Filtro secundário: Abas de categorias dos subsistemas (Trilho Horizontal no Mobile) */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-1">
              <span className="text-[11px] sm:text-xs font-bold text-slate-400 uppercase tracking-wider shrink-0">Filtrar Subsistemas:</span>
              <div className="flex items-center gap-1 rounded-lg bg-slate-900 p-1 border border-slate-800 text-xs overflow-x-auto no-scrollbar max-w-full">
                {[
                  { id: 'ALL', label: 'Todos os 6 Gráficos' },
                  { id: 'clima', label: 'Microclima' },
                  { id: 'agro', label: 'VPD & ET₀' },
                  { id: 'solar', label: 'Radiação & PAR' },
                  { id: 'solo', label: 'Solo' },
                  { id: 'baro', label: 'Barometria' },
                  { id: 'bioclima', label: 'Bioclima (ITU)' }
                ].map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setChartFilter(tab.id)}
                    className={`px-3 py-1.5 rounded-md font-semibold transition cursor-pointer whitespace-nowrap shrink-0 text-xs ${
                      chartFilter === tab.id ? 'bg-emerald-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Grid dos Gráficos Separados (2 Colunas em telas largas, 1 Coluna no mobile) */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 sm:gap-6">

              {/* GRÁFICO 1: Microclima (Temperatura & Umidade do Ar) */}
              {(chartFilter === 'ALL' || chartFilter === 'clima') && (
                <div className="p-4 sm:p-5 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-3 shadow-sm">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 pb-2 border-b border-slate-800/80">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="p-1.5 rounded-lg bg-amber-950/60 text-amber-400 shrink-0">
                        <Thermometer className="w-4 h-4" />
                      </div>
                      <div className="min-w-0">
                        <h4 className="text-sm font-bold text-white truncate">Microclima & Psicrometria</h4>
                        <p className="text-[10px] sm:text-[11px] text-slate-400 truncate">Temp. do Ar (°C), Ponto de Orvalho e Umidade (%)</p>
                      </div>
                    </div>
                    <div className="text-left sm:text-right shrink-0">
                      <span className="text-xs font-bold text-amber-400">{selectedStation.temp_ref || selectedStation.temp_dht || '--'} °C</span>
                      <span className="text-slate-500 mx-1">/</span>
                      <span className="text-xs font-bold text-cyan-400">{selectedStation.umidade || '--'}%</span>
                    </div>
                  </div>
                  <div className="h-56 sm:h-64">
                    <Line data={chartDataClima} options={chartOptionsClima} />
                  </div>
                </div>
              )}

              {/* GRÁFICO 2: Balanço Hídrico & Transpiração (VPD, ET0 e ETc) */}
              {(chartFilter === 'ALL' || chartFilter === 'agro') && (
                <div className="p-4 sm:p-5 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-3 shadow-sm">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 pb-2 border-b border-slate-800/80">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="p-1.5 rounded-lg bg-emerald-950/60 text-emerald-400 shrink-0">
                        <Gauge className="w-4 h-4" />
                      </div>
                      <div className="min-w-0">
                        <h4 className="text-sm font-bold text-white truncate">Balanço Hídrico & Transpiração</h4>
                        <p className="text-[10px] sm:text-[11px] text-slate-400 truncate">VPD (kPa) e Evapotranspiração ET₀ / ETc (mm)</p>
                      </div>
                    </div>
                    <div className="text-left sm:text-right shrink-0">
                      <span className="text-xs font-bold text-emerald-400">VPD: {selectedStation.vpd || '--'} kPa</span>
                    </div>
                  </div>
                  <div className="h-56 sm:h-64">
                    <Line data={chartDataAgro} options={chartOptionsAgro} />
                  </div>
                </div>
              )}

              {/* GRÁFICO 3: Radiação Solar & Atividade Fotossintética (Rs e PAR) */}
              {(chartFilter === 'ALL' || chartFilter === 'solar') && (
                <div className="p-4 sm:p-5 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-3 shadow-sm">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 pb-2 border-b border-slate-800/80">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="p-1.5 rounded-lg bg-yellow-950/60 text-yellow-400 shrink-0">
                        <Sun className="w-4 h-4" />
                      </div>
                      <div className="min-w-0">
                        <h4 className="text-sm font-bold text-white truncate">Radiação Solar & PAR</h4>
                        <p className="text-[10px] sm:text-[11px] text-slate-400 truncate">Radiação Global Rs (W/m²) e PAR (µmol/m²/s)</p>
                      </div>
                    </div>
                    <div className="text-left sm:text-right shrink-0">
                      <span className="text-xs font-bold text-amber-400">{selectedStation.rs || 0} W/m²</span>
                    </div>
                  </div>
                  <div className="h-56 sm:h-64">
                    <Line data={chartDataSolar} options={chartOptionsSolar} />
                  </div>
                </div>
              )}

              {/* GRÁFICO 4: Perfil do Solo (Umidade & Temperatura Subterrânea) */}
              {(chartFilter === 'ALL' || chartFilter === 'solo') && (
                <div className="p-4 sm:p-5 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-3 shadow-sm">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 pb-2 border-b border-slate-800/80">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="p-1.5 rounded-lg bg-emerald-950/60 text-emerald-400 shrink-0">
                        <Sprout className="w-4 h-4" />
                      </div>
                      <div className="min-w-0">
                        <h4 className="text-sm font-bold text-white truncate">Perfil Subterrâneo do Solo</h4>
                        <p className="text-[10px] sm:text-[11px] text-slate-400 truncate">Umidade do Solo (%) e Temperatura Solo (°C)</p>
                      </div>
                    </div>
                    <div className="text-left sm:text-right shrink-0">
                      <span className="text-xs font-bold text-emerald-400">{selectedStation.umidade_solo || '--'}% Solo</span>
                    </div>
                  </div>
                  <div className="h-56 sm:h-64">
                    <Line data={chartDataSolo} options={chartOptionsSolo} />
                  </div>
                </div>
              )}

              {/* GRÁFICO 5: Barometria & Previsão Meteorológica (Pressão e ΔP) */}
              {(chartFilter === 'ALL' || chartFilter === 'baro') && (
                <div className="p-4 sm:p-5 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-3 shadow-sm">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 pb-2 border-b border-slate-800/80">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="p-1.5 rounded-lg bg-purple-950/60 text-purple-400 shrink-0">
                        <Compass className="w-4 h-4" />
                      </div>
                      <div className="min-w-0">
                        <h4 className="text-sm font-bold text-white truncate">Pressão Atmosférica & Tendência</h4>
                        <p className="text-[10px] sm:text-[11px] text-slate-400 truncate">Pressão (hPa) e Variação ΔP nas últimas 3h</p>
                      </div>
                    </div>
                    <div className="text-left sm:text-right shrink-0">
                      <span className="text-xs font-bold text-purple-400">{selectedStation.pressao || '--'} hPa</span>
                    </div>
                  </div>
                  <div className="h-56 sm:h-64">
                    <Line data={chartDataBaro} options={chartOptionsBaro} />
                  </div>
                </div>
              )}

              {/* GRÁFICO 6: Bioclimatologia & Estresse Térmico (ITU e Heat Index) */}
              {(chartFilter === 'ALL' || chartFilter === 'bioclima') && (
                <div className="p-4 sm:p-5 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-3 shadow-sm">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 pb-2 border-b border-slate-800/80">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="p-1.5 rounded-lg bg-rose-950/60 text-rose-400 shrink-0">
                        <Activity className="w-4 h-4" />
                      </div>
                      <div className="min-w-0">
                        <h4 className="text-sm font-bold text-white truncate">Bioclimatologia & Conforto Térmico</h4>
                        <p className="text-[10px] sm:text-[11px] text-slate-400 truncate">Índice ITU e Sensação Térmica Heat Index (°C)</p>
                      </div>
                    </div>
                    <div className="text-left sm:text-right shrink-0">
                      <span className="text-xs font-bold text-rose-400">ITU: {selectedStation.itu || '--'}</span>
                    </div>
                  </div>
                  <div className="h-56 sm:h-64">
                    <Line data={chartDataBioclima} options={chartOptionsBioclima} />
                  </div>
                </div>
              )}

            </div>
          </div>

          {/* 5. Tabela Completa dos 25 Registros Gravados no PostgreSQL */}
          <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800 overflow-hidden shadow-sm">
            <div className="flex flex-wrap justify-between items-center gap-3 mb-4">
              <div>
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <FileText className="w-4 h-4 text-emerald-400" />
                  <span>Histórico Detalhado da Estação (PostgreSQL)</span>
                </h3>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Registro sequencial de todas as grandezas agronômicas, ambientais e diagnósticos de hardware.
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-400 font-mono">
                  Total: <strong className="text-white">{stationHistory.length}</strong> medições
                </span>
                <button
                  onClick={exportarCSV}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-emerald-400 border border-slate-700 transition"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>CSV</span>
                </button>
              </div>
            </div>

            <div className="overflow-x-auto max-h-96">
              <table className="w-full text-left text-xs text-slate-300">
                <thead className="bg-slate-800/90 text-slate-400 border-b border-slate-700 sticky top-0 backdrop-blur-sm z-10">
                  <tr>
                    <th className="py-2.5 px-3">Data / Hora</th>
                    <th className="py-2.5 px-3">Temp. Ar</th>
                    <th className="py-2.5 px-3">Umid. Ar</th>
                    <th className="py-2.5 px-3">Umid. Solo</th>
                    <th className="py-2.5 px-3">Temp. Solo</th>
                    <th className="py-2.5 px-3">VPD</th>
                    <th className="py-2.5 px-3">ET₀</th>
                    <th className="py-2.5 px-3">ETc</th>
                    <th className="py-2.5 px-3">Rad. Solar (Rs)</th>
                    <th className="py-2.5 px-3">PAR</th>
                    <th className="py-2.5 px-3">P. Orvalho</th>
                    <th className="py-2.5 px-3">Pressão</th>
                    <th className="py-2.5 px-3">ΔP</th>
                    <th className="py-2.5 px-3">ITU</th>
                    <th className="py-2.5 px-3">HI</th>
                    <th className="py-2.5 px-3">Fungo</th>
                    <th className="py-2.5 px-3">Geada</th>
                    <th className="py-2.5 px-3">Qualidade</th>
                    <th className="py-2.5 px-3">RAM Heap</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80">
                  {stationHistory.slice().reverse().map(h => (
                    <tr key={h.id} className="hover:bg-slate-800/50 transition font-mono">
                      <td className="py-2 px-3 text-slate-400 whitespace-nowrap">{formatarData(h.timestamp_utc, h.data_hora)}</td>
                      <td className="py-2 px-3 font-bold text-amber-300">{(h.temp_ref || h.temp_dht || '--')}°C</td>
                      <td className="py-2 px-3 text-cyan-300">{h.umidade || '--'}%</td>
                      <td className="py-2 px-3 text-emerald-400 font-bold">{h.umidade_solo !== null ? h.umidade_solo + '%' : '--'}</td>
                      <td className="py-2 px-3 text-indigo-300">{h.temp_solo ? h.temp_solo + '°C' : '--'}</td>
                      <td className="py-2 px-3 font-semibold text-emerald-400">{h.vpd || '--'}</td>
                      <td className="py-2 px-3 text-blue-400">{h.et0 || '--'}</td>
                      <td className="py-2 px-3 text-purple-400">{h.etc || '--'}</td>
                      <td className="py-2 px-3 text-amber-400">{h.rs ? h.rs + ' W' : '--'}</td>
                      <td className="py-2 px-3 text-teal-300">{h.par || '--'}</td>
                      <td className="py-2 px-3 text-cyan-200">{h.ponto_orvalho ? h.ponto_orvalho + '°C' : '--'}</td>
                      <td className="py-2 px-3 text-purple-300">{h.pressao || '--'}</td>
                      <td className="py-2 px-3 text-slate-400">{h.dp || 0}</td>
                      <td className="py-2 px-3 text-rose-300">{h.itu || '--'}</td>
                      <td className="py-2 px-3 text-amber-200">{h.hi ? h.hi + '°C' : '--'}</td>
                      <td className="py-2 px-3">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-sans font-bold ${
                          h.rf === 2 ? 'bg-red-900 text-red-200' : (h.rf === 1 ? 'bg-amber-900 text-amber-200' : 'bg-slate-800 text-slate-400')
                        }`}>
                          {h.rf === 2 ? 'ALTO' : (h.rf === 1 ? 'Mod' : 'Baixo')}
                        </span>
                      </td>
                      <td className="py-2 px-3">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-sans font-bold ${
                          h.rg === 2 ? 'bg-purple-900 text-purple-200' : (h.rg === 1 ? 'bg-blue-900 text-blue-200' : 'bg-slate-800 text-slate-400')
                        }`}>
                          {h.rg === 2 ? 'NEGRA' : (h.rg === 1 ? 'Branca' : 'Não')}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-emerald-400">{h.qualidade || 100}%</td>
                      <td className="py-2 px-3 text-slate-400">{h.heap_mod || 412} KB</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

        </main>
      )}

      {/* 🔐 MODAL DE LOGIN / REGISTRO (100% RESPONSIVO) */}
      {authModalOpen && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4">
          <div className="bg-white text-slate-800 rounded-2xl max-w-sm w-full p-5 sm:p-6 shadow-2xl border border-slate-200 max-h-[90dvh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4 sm:mb-5">
              <div className="flex items-center gap-2">
                <img src="/gaia_logo.png" alt="GAIA Logo" className="w-7 h-7 rounded-lg" />
                <h3 className="font-bold text-slate-900 text-base">
                  {authMode === 'login' ? 'Entrar no Sistema' : 'Criar Nova Conta'}
                </h3>
              </div>
              <button onClick={() => setAuthModalOpen(false)} className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Alternância de Abas */}
            <div className="flex rounded-lg bg-slate-100 p-1 mb-4 text-xs font-semibold">
              <button
                type="button"
                onClick={() => { setAuthMode('login'); setAuthError(''); }}
                className={`flex-1 py-2 rounded-md transition cursor-pointer ${authMode === 'login' ? 'bg-white shadow text-slate-900 font-bold' : 'text-slate-500'}`}
              >
                Login
              </button>
              <button
                type="button"
                onClick={() => { setAuthMode('register'); setAuthError(''); }}
                className={`flex-1 py-2 rounded-md transition cursor-pointer ${authMode === 'register' ? 'bg-white shadow text-slate-900 font-bold' : 'text-slate-500'}`}
              >
                Criar Conta
              </button>
            </div>

            {authError && (
              <div className="mb-4 p-2.5 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{authError}</span>
              </div>
            )}

            <form onSubmit={handleAuthSubmit} className="space-y-3.5 text-xs">
              {authMode === 'register' && (
                <div>
                  <label className="block text-slate-600 font-medium mb-1">Nome Completo</label>
                  <input
                    type="text"
                    required
                    placeholder="Seu nome"
                    value={authForm.nome}
                    onChange={e => setAuthForm({ ...authForm, nome: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 text-slate-900 text-sm focus:outline-none focus:border-emerald-500"
                  />
                </div>
              )}

              <div>
                <label className="block text-slate-600 font-medium mb-1">E-mail</label>
                <input
                  type="email"
                  required
                  placeholder="exemplo@dominio.com"
                  value={authForm.email}
                  onChange={e => setAuthForm({ ...authForm, email: e.target.value })}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 text-slate-900 text-sm focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-600 font-medium mb-1">Senha</label>
                <input
                  type="password"
                  required
                  placeholder="••••••••"
                  value={authForm.senha}
                  onChange={e => setAuthForm({ ...authForm, senha: e.target.value })}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 text-slate-900 text-sm focus:outline-none focus:border-emerald-500"
                />
              </div>

              <button
                type="submit"
                disabled={authLoading}
                className="w-full py-3 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm transition shadow-sm flex items-center justify-center gap-2 cursor-pointer mt-2"
              >
                {authLoading ? 'Processando...' : (authMode === 'login' ? 'Entrar' : 'Cadastrar')}
              </button>
            </form>

            <div className="mt-4 pt-3 border-t border-slate-100 text-center text-[11px] text-slate-400">
              {authMode === 'login' ? (
                <span>Conta Master disponível para o administrador.</span>
              ) : (
                <span>Novas contas cadastradas têm acesso a estações públicas.</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 📍 MODAL: EDITAR ESTAÇÃO, VISIBILIDADE E STATUS FINANCEIRO (100% RESPONSIVO) */}
      {editModalOpen && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-md w-full p-4 sm:p-6 shadow-2xl max-h-[90dvh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4 pb-2 border-b border-slate-800">
              <h3 className="text-sm font-bold text-white flex items-center gap-2 truncate">
                <MapPin className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>Configurar Estação ({selectedStation?.cod_estacao})</span>
              </h3>
              <button onClick={() => setEditModalOpen(false)} className="p-1 text-slate-400 hover:text-white rounded cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={salvarEdicao} className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-400 mb-1">Nome da Estação</label>
                <input
                  type="text"
                  value={editForm.nome}
                  onChange={e => setEditForm({ ...editForm, nome: e.target.value })}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm"
                  required
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Cultura / Talhão</label>
                <input
                  type="text"
                  value={editForm.cultura}
                  onChange={e => setEditForm({ ...editForm, cultura: e.target.value })}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm"
                />
              </div>

              {/* Visibilidade e Financeiro (Permissões de Acesso) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <div>
                  <label className="block text-slate-400 mb-1 font-semibold">Visibilidade</label>
                  <select
                    value={editForm.visibilidade}
                    onChange={e => setEditForm({ ...editForm, visibilidade: e.target.value })}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm cursor-pointer"
                  >
                    <option value="PUBLICA">Pública (Aberta)</option>
                    <option value="PRIVADA">Privada (Apenas Dono/Admin)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-slate-400 mb-1 font-semibold">Mensalidade</label>
                  <select
                    value={editForm.status_financeiro}
                    disabled={user?.role !== 'ADMIN'}
                    onChange={e => setEditForm({ ...editForm, status_financeiro: e.target.value })}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm disabled:opacity-50 cursor-pointer"
                  >
                    <option value="ATIVO">Em Dia (Ativo)</option>
                    <option value="PENDENTE">Inadimplente (Pendente)</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <div>
                  <label className="block text-slate-400 mb-1">Latitude</label>
                  <input
                    type="number"
                    step="0.000001"
                    value={editForm.latitude}
                    onChange={e => setEditForm({ ...editForm, latitude: parseFloat(e.target.value) })}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm"
                    required
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Longitude</label>
                  <input
                    type="number"
                    step="0.000001"
                    value={editForm.longitude}
                    onChange={e => setEditForm({ ...editForm, longitude: parseFloat(e.target.value) })}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm"
                    required
                  />
                </div>
              </div>

              {/* Chave Criptográfica AES e Token de Autenticação Real */}
              <div className="p-3 bg-slate-800/90 rounded-xl border border-slate-700 space-y-2.5 mt-2">
                <div>
                  <div className="flex justify-between items-center mb-1">
                    <label className="text-[11px] font-semibold text-emerald-400">Chave AES-128 do Projeto GAIA</label>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText('GaiaAgroIoT2026!');
                        alert('Chave AES copiada: GaiaAgroIoT2026!');
                      }}
                      className="text-[10px] text-emerald-300 hover:text-white underline cursor-pointer"
                    >
                      Copiar Chave
                    </button>
                  </div>
                  <input
                    type="text"
                    readOnly
                    value="GaiaAgroIoT2026!"
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-2 text-white font-mono text-xs cursor-pointer select-all"
                  />
                  <div className="text-[10px] text-slate-500 mt-0.5">Utilize no campo "Chave Criptográfica" do ESP32.</div>
                </div>

                <div>
                  <div className="flex justify-between items-center mb-1">
                    <label className="text-[11px] font-semibold text-teal-300">Token da Estação (API Key)</label>
                    <button
                      type="button"
                      onClick={() => {
                        if (editForm.api_token) {
                          navigator.clipboard.writeText(editForm.api_token);
                          alert('Token copiado: ' + editForm.api_token);
                        }
                      }}
                      className="text-[10px] text-teal-300 hover:text-white underline cursor-pointer"
                    >
                      Copiar Token
                    </button>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={editForm.api_token || ''}
                      onChange={e => setEditForm({ ...editForm, api_token: e.target.value })}
                      className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-2 text-white font-mono text-xs"
                      placeholder="gaia_sec_G00001_..."
                    />
                    <button
                      type="button"
                      onClick={() => setEditForm({
                        ...editForm,
                        api_token: `gaia_sec_${selectedStation?.cod_estacao || 'STA'}_${Math.random().toString(36).substring(2, 10)}`
                      })}
                      className="px-2.5 py-1.5 bg-slate-700 hover:bg-slate-600 rounded-lg text-[11px] font-bold text-slate-200 shrink-0 cursor-pointer"
                    >
                      Novo
                    </button>
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5">Token exclusivo desta estação.</div>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setEditModalOpen(false)}
                  className="px-3.5 py-2 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold cursor-pointer shadow-sm"
                >
                  Salvar Alterações
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
}
