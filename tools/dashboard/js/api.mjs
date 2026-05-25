export const api = path =>
  fetch('/api/' + path).then(r => {
    if (r.ok) return r.json();
    const e = new Error(r.statusText || String(r.status));
    e.status = r.status;
    return Promise.reject(e);
  });

export const apiText = path =>
  fetch('/api/' + path).then(r => r.ok ? r.text() : Promise.reject(r.statusText));
