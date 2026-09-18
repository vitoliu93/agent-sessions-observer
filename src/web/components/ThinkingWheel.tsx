import { useEffect, useRef } from 'react';
import type { Draft } from '../../shared/types.ts';

interface ThinkingWheelProps {
  draft: Draft | null;
  analyzing: boolean;
  sessionId?: string | null;
}

export default function ThinkingWheel({ draft, analyzing }: ThinkingWheelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);

  const thinking = draft?.thinking || '';
  const toolCalls = draft?.toolCalls || [];

  // 保持自动向上滚轮推进：当新内容到达且用户未向上翻阅时，自动保持贴底
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || userScrolledRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [thinking, toolCalls.length]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    userScrolledRef.current = !atBottom;
  };

  // 按换行或段落分割条目，确保滚轮逐行上推
  const lines = thinking
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-center justify-center px-4 pt-20 pb-16">
      {/* 无边框滚轮渐隐视窗 */}
      <div className="wheel-mask relative h-[420px] w-full">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="h-full overflow-y-auto px-4 pt-12 pb-32 text-[14px] leading-[1.8] text-ink/85 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
        >
          {lines.length === 0 && toolCalls.length === 0 ? (
            <div className="flex h-full items-center justify-center text-center text-sm text-muted">
              <span className="soft-pulse mr-2 inline-block size-1.5 rounded-full bg-accent" />
              正在读取会话事件流并启动推演分析…
            </div>
          ) : (
            <div className="space-y-3">
              {lines.map((line, i) => {
                const isLast = i === lines.length - 1;
                const isCitation = line.startsWith('[host:') || line.startsWith('[');
                return (
                  <div key={i} className="wheel-item-anim transition-all duration-300">
                    <p className={`whitespace-pre-wrap ${isCitation ? 'font-medium text-ink' : 'text-ink-subtle'}`}>
                      {line}
                      {isLast && analyzing && (
                        <span className="ml-1 inline-block h-3.5 w-1.5 align-middle bg-accent/80 animate-pulse" />
                      )}
                    </p>
                  </div>
                );
              })}

              {/* 交叉验证工具调用流 */}
              {toolCalls.length > 0 && (
                <div className="my-4 space-y-2 border-t border-line/60 pt-3">
                  <div className="text-[11px] font-medium tracking-wider text-muted uppercase">
                    只读交叉验证记录
                  </div>
                  {toolCalls.map((tool, idx) => (
                    <div
                      key={tool.id || idx}
                      className="wheel-item-anim flex items-start gap-2.5 rounded-md border border-line bg-paper p-2.5 text-xs shadow-xs"
                    >
                      <span className="inline-flex shrink-0 items-center gap-1 rounded border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[11px] font-medium text-sky-700">
                        🔍 {tool.name}
                      </span>
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="font-mono text-[11.5px] text-muted truncate">
                          {typeof tool.args === 'string'
                            ? tool.args
                            : JSON.stringify(tool.args || {})}
                        </div>
                        {tool.result && (
                          <div className="text-[12px] text-ink/75 line-clamp-2">
                            {tool.result}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
