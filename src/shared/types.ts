// 前后端数据契约：地图卡片、边、快照与 HTTP 响应。后端产出，前端只读。

export type CardType = 'goal' | 'subgoal' | 'change' | 'risk' | 'verify' | 'concl' | 'gap' | 'group';
export type State = 'doing' | 'done' | 'failed' | 'partial' | 'risk' | 'resolved' | 'unknown';
/** 包含：前端按卡片归属补的虚线边，模型不输出 */
export type Verb = '拆成' | '接着' | '推翻' | '采用' | '妨碍' | '解决' | '检查' | '支持' | '留下缺口' | '包含';

export interface Sig { verb: string; agent: string }
export interface Step { title: string; who: string; st: State }

export interface Card {
  id: string;
  type: CardType;
  title: string;
  sub: string;
  st: State;
  sig: Sig[];
  /** 仅 goal 卡：验收条件 */
  acc?: string[];
  facts?: string[];
  ev?: string;
  /** 系统说明（校验时移除的署名/来源等），不算事实 */
  notes?: string[];
  steps?: Step[];
  /** 归属的子目标 ID；后端已把模型的 zone/zoneId 兼容字段折算进来，解析不到为 'unknown' */
  goalId?: string;
}

export interface Edge { f: string; t: string; v: Verb }

export interface Live { now?: string; known?: string; next?: string; nextK?: string }

export interface MapResult { goals: Card[]; cards: Card[]; edges: Edge[]; live: Live; note: string }

export interface CoverageSession { key: string; totalChars: number; includedChars: number; truncated: boolean }
export interface Coverage { truncated: boolean; missing: string[]; note: string; sessions: CoverageSession[] }

export interface ChildView { key: string; label: string; kind: string; events: number; matched: string }
export interface Stamp { at: number; data: string; summary: string }

/** 一次成功归纳的完整快照；历史回放与抽屉都读它 */
export interface Snapshot {
  at: number;
  /** 用户先后提出的目标，按提出顺序 */
  goals: Card[];
  cards: Card[];
  edges: Edge[];
  live: Live;
  note: string;
  children: ChildView[];
  /** 只有本次同步的一条 */
  stamps: Stamp[];
  updatedAt: string | null;
  dataReadAt: string | null;
  coverage?: Coverage;
}

/** 模型还在输出时已写完的部分；只在分析中存在，不进历史 */
export interface Draft {
  goals: Card[];
  cards: Card[];
  edges: Edge[];
  live: Live;
  /** 已收到的模型正文字数 */
  chars: number;
  startedAt: string;
}

/** GET /api/data */
export interface DataView extends Omit<Snapshot, 'at' | 'coverage'> {
  coverage?: Coverage;
  sessionId: string | null;
  syncN: number;
  lastError: string | null;
  analyzing: boolean;
  boot: string;
  historySince: number;
  history: Snapshot[];
  draft: Draft | null;
}

/** GET /api/sessions 列表项 */
export interface SessionItem {
  sid: string;
  short: string;
  prefix: string;
  title: string;
  syncN: number;
  analyzing: boolean;
  lastError: string | null;
  updatedAt: string | null;
  cards: number;
  note: string;
  children: number;
}
