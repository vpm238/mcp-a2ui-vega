/**
 * Layout components. A2UI's basic catalog has Row and Column; a dashboard also
 * needs a grid that collapses gracefully and a titled block, so that swapping
 * one idea on the dashboard means replacing one component by id.
 */
import { useEffect, useRef, useState } from 'react';
import { createComponentImplementation } from '@a2ui/react/v0_9';
import { DashboardGridApi, SectionApi } from '@mcp-a2ui-vega/catalog';

/** Four KPI tiles want less room each than two charts do. */
const defaultMinWidth = (columns: number) => (columns >= 4 ? 200 : columns === 3 ? 250 : 320);

export const DashboardGrid = createComponentImplementation(DashboardGridApi, ({ props, buildChild }) => {
  const children = (props.children ?? []) as string[];
  const columns = Math.min(4, Math.max(1, Number(props.columns ?? 2)));
  const minWidth = Number(props.minColumnWidth ?? defaultMinWidth(columns));
  const host = useRef<HTMLDivElement>(null);
  const [actual, setActual] = useState(columns);

  /**
   * CSS `auto-fit` can set a floor on column width but not a ceiling on column
   * count, and "four tiles" has to mean four on a wide panel — not six. So the
   * count is measured: as many columns as fit, capped at what was asked for.
   * An MCP App is resized constantly as the host panel moves, which is why this
   * observes rather than guessing from the viewport.
   */
  useEffect(() => {
    const element = host.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? 0;
      setActual(Math.max(1, Math.min(columns, Math.floor(width / minWidth) || 1)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [columns, minWidth]);

  return (
    <div
      ref={host}
      className="grid"
      style={{
        gridTemplateColumns: `repeat(${actual}, minmax(0, 1fr))`,
        gap: props.gap ? `${props.gap}px` : undefined,
      }}
      data-columns={actual}
    >
      {children.map(id => (
        <div className="grid__cell" key={id}>
          {buildChild(id)}
        </div>
      ))}
    </div>
  );
});

export const Section = createComponentImplementation(SectionApi, ({ props, buildChild }) => (
  <section className="section">
    {props.title || props.trailing ? (
      <header className="section__header">
        <div>
          {props.title ? <h2 className="section__title">{props.title}</h2> : null}
          {props.subtitle ? <p className="section__subtitle">{props.subtitle}</p> : null}
        </div>
        {props.trailing ? <div className="section__trailing">{buildChild(props.trailing)}</div> : null}
      </header>
    ) : null}
    <div className="section__body">{buildChild(props.child)}</div>
  </section>
));
