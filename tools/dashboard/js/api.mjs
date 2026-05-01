export const api = path =>
  fetch('/api/' + path).then(r => r.ok ? r.json() : Promise.reject(r.statusText));

export const apiText = path =>
  fetch('/api/' + path).then(r => r.ok ? r.text() : Promise.reject(r.statusText));
