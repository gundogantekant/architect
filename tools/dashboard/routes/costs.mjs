export default function costsRoutes({ db, json, err }) {
  return [
    [/^\/api\/costs\/work-item\/([^/]+)$/, 'GET', async (m, _req, res) => {
      const data = await db.getCostByWorkItem(m[1]);
      json(res, data);
    }],
    [/^\/api\/costs\/project\/(.+)$/, 'GET', async (m, _req, res) => {
      const data = await db.getCostByProject(decodeURIComponent(m[1]));
      json(res, data);
    }],
    [/^\/api\/costs\/epic\/([^/]+)$/, 'GET', async (m, _req, res) => {
      const data = await db.getCostByEpic(m[1]);
      json(res, data);
    }],
  ];
}
