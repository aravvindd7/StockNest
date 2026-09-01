import axios from "axios";

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "http://localhost:5001/api",
});

// Attach the JWT (if present) to every outgoing request.
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("sn_token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// On a 401 (expired/invalid token), clear local auth state so the app
// falls back to the login screen instead of looping on failed requests.
// AuthContext listens for this event to update its state.
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem("sn_token");
      localStorage.removeItem("sn_user");
      window.dispatchEvent(new Event("sn:unauthorized"));
    }
    return Promise.reject(error);
  }
);

export default api;
