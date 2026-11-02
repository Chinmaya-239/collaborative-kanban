import axios from 'axios';

export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';
const state = { token: null, tenantId: null };
export const setAuthToken = (t) => { state.token = t; };
/** Must be called synchronously whenever the active tenant changes (before children fetch). */
export const setActiveTenant = (id) => { state.tenantId = id; };

export const api = axios.create({ baseURL: `${API_URL}/api` });
api.interceptors.request.use((config) => {
  if (state.token) config.headers.Authorization = `Bearer ${state.token}`;
  if (state.tenantId && !config.skipTenant) config.headers['X-Tenant-Id'] = state.tenantId;
  return config;
});
export const errMsg = (e) => e?.response?.data?.error || e?.message || 'Something went wrong';
