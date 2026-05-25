import * as fs from 'fs';
import * as path from 'path';

// RagContext is the single typed interface for all RAG sources.
// Fallback ordering: portfolio always local (filesystem), backlog HTTP → fixture, history from workflow state.
export interface RagContext {
  portfolioEntries: PortfolioEntry[];
  backlogItems: BacklogItem[];
  sessionHistory: string[];
}

export interface PortfolioEntry {
  relativePath: string;
  summary: Record<string, unknown>;
}

export interface BacklogItem {
  id: string;
  title: string;
  status: string;
  project_key: string;
}

export interface RagRetrievalInput {
  projectKey: string;
  sessionHistory: string[];
  maxPortfolioFiles?: number;
}

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:3777';

async function fetchBacklogWithFallback(fixturePath: string): Promise<BacklogItem[]> {
  try {
    const response = await fetch(`${DASHBOARD_URL}/api/backlog`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as { items?: BacklogItem[] };
    return Array.isArray(data.items) ? data.items : [];
  } catch (err) {
    // Dashboard unreachable — fall back to fixture. Log so operators can observe the degradation.
    console.warn(`[ragRetrieval] dashboard unreachable (${String(err)}), using fixture: ${fixturePath}`);
    if (fs.existsSync(fixturePath)) {
      try {
        const raw = fs.readFileSync(fixturePath, 'utf-8');
        const data = JSON.parse(raw) as { items?: BacklogItem[] };
        return Array.isArray(data.items) ? data.items : [];
      } catch {
        return [];
      }
    }
    return [];
  }
}

function readPortfolioEntries(portfolioDir: string, maxFiles: number): PortfolioEntry[] {
  if (!portfolioDir || !fs.existsSync(portfolioDir)) return [];

  const entries: PortfolioEntry[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || entries.length >= maxFiles) return;
    let items: string[];
    try {
      items = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const item of items) {
      if (entries.length >= maxFiles) break;
      const fullPath = path.join(dir, item);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (item.endsWith('.json')) {
          const content = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as Record<string, unknown>;
          entries.push({
            relativePath: fullPath.replace(portfolioDir + path.sep, ''),
            summary: content,
          });
        }
      } catch {
        // skip unreadable files
      }
    }
  };

  walk(portfolioDir, 0);
  return entries;
}

export async function ragRetrieval(input: RagRetrievalInput): Promise<RagContext> {
  const portfolioDir = process.env.ARCHITECT_PORTFOLIO_DIR ?? '';
  // Use process.cwd() (the package root: tools/temporal/) so the fixture path resolves
  // correctly whether running from source (ts-node) or compiled output (dist/).
  const fixturePath = path.join(process.cwd(), 'fixtures', 'backlog.json');

  const [portfolioEntries, backlogItems] = await Promise.all([
    Promise.resolve(readPortfolioEntries(portfolioDir, input.maxPortfolioFiles ?? 10)),
    fetchBacklogWithFallback(fixturePath),
  ]);

  return {
    portfolioEntries,
    backlogItems,
    sessionHistory: input.sessionHistory,
  };
}
