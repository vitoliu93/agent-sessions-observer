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
  /** 快判（Jev）核对：引用的原文撑得住这张卡说法的概率 0–1；没核对过则没有 */
  support?: number;
  /** 慢模型改写过标题时，这里留着 Jev 摘的原话 */
  raw?: string;
  /** jev 画图：这张卡慢模型审过了；没有就是 Jev 刚画出来的底稿 */
  reviewed?: boolean;
}

export interface Edge { f: string; t: string; v: Verb }

/** 证据支持度低于这个数，页面标「证据弱」 */
export const WEAK_AT = 0.5;

export type Phase = 'exploring' | 'editing' | 'verifying' | 'waiting_user' | 'stuck';
/** 快判（Jev）对会话此刻的判断；和地图分开更新，几百毫秒一次 */
export interface Pulse {
  at: string;
  phase: Phase;
  /** phase 的把握度 0–1 */
  confidence: number;
  /** 卡住的概率 */
  stuck: number;
  /** 新事件会改变地图的概率 */
  changed: number;
  ms: number;
  /** 上次慢同步之后，快判拦下了几次重新归纳 */
  skipped: number;
  /** 这一次有没有叫醒慢模型 */
  woke: boolean;
}

export interface Live { now?: string; known?: string; next?: string; nextK?: string }

export interface MapResult { goals: Card[]; cards: Card[]; edges: Edge[]; live: Live; note: string }

export interface CoverageSession { key: string; totalChars: number; includedChars: number; truncated: boolean }
export interface Coverage { truncated: boolean; missing: string[]; note: string; sessions: CoverageSession[] }

export interface ChildView { key: string; label: string; kind: string; events: number; matched: string }

export interface ToolCallView {
  id?: string;
  name: string;
  args?: any;
  result?: string;
  isError?: boolean;
}

/** 当前这一版地图。不留历史：jev 画图几秒一版，旧版没有回看的意义 */
export interface Snapshot {
  /** 用户先后提出的目标，按提出顺序 */
  goals: Card[];
  cards: Card[];
  edges: Edge[];
  live: Live;
  note: string;
  children: ChildView[];
  updatedAt: string | null;
  dataReadAt: string | null;
  coverage?: Coverage;
  thinking?: string;
  toolCalls?: ToolCallView[];
}

/** 模型还在输出时已写完的部分；只在分析中存在 */
export interface Draft {
  goals: Card[];
  cards: Card[];
  edges: Edge[];
  live: Live;
  /** 已收到的模型正文字数 */
  chars: number;
  startedAt: string;
  /** 实时思考/推演内容 */
  thinking?: string;
  /** 只读交叉验证调用记录 */
  toolCalls?: ToolCallView[];
}

/** GET /api/data */
export interface DataView extends Snapshot {
  sessionId: string | null;
  syncN: number;
  lastError: string | null;
  analyzing: boolean;
  draft: Draft | null;
  pulse: Pulse | null;
  /** 地图由谁画：jev 几秒一版，卡片文字摘自原文；cli 是本机慢模型归纳 */
  engine: 'jev' | 'cli';
  /** jev 画图时慢模型审图：正在审、上次审完的时间、底稿里还没审过的卡数。没装模型 CLI 时 on 为 false */
  review: { on: boolean; running: boolean; at: string | null; unreviewed: number; error: string | null };
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
  phase: Phase | null;
}
