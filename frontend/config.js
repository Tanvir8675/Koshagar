window.KoshAgarConfig = window.KoshAgarConfig || {};

const __koshagarQuery = new URLSearchParams(window.location.search || '');
const __koshagarBackendFromQuery = __koshagarQuery.get('backendUrl');

window.KoshAgarConfig.backendUrl = __koshagarBackendFromQuery || window.KoshAgarConfig.backendUrl || 'http://localhost:3001';
window.__KOSHAGAR_BACKEND_URL = window.KoshAgarConfig.backendUrl;
