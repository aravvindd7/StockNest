import api from "./api";

/**
 * identifier: username OR email — the backend figures out which,
 * and always determines the role from the database, never from the client.
 */
export async function loginRequest(identifier, password) {
  const { data } = await api.post("/auth/login", { identifier, password });
  return data; // { token, user }
}

export async function fetchCurrentUser() {
  const { data } = await api.get("/auth/me");
  return data.user;
}

export async function logoutRequest() {
  await api.post("/auth/logout");
}
