import { type GraphRow, type GraphSegment } from "../graph/layout";

// The per-row commit-graph cell (spec 10): lane segments, edges, and the commit node for
// one history row, drawn as SVG. Self-contained per row so it composes with virtualization
// (REQ-GRAPH-017); lane colors come from the active theme palette (REQ-GRAPH-011). Edges
// are split top/bottom at the node centre, so the node sits exactly on its lane mid-row.

export const LANE_WIDTH = 14;
const NODE_RADIUS = 4;

const laneX = (lane: number): number => lane * LANE_WIDTH + LANE_WIDTH / 2;
const stroke = (color: number): string => `var(--color-graph-${color})`;

/** SVG path for one half-edge: a vertical line, or a smooth S-curve when the lane shifts. */
const segmentPath = (segment: GraphSegment, height: number): string => {
  const x1 = laneX(segment.fromLane);
  const x2 = laneX(segment.toLane);
  const y1 = segment.fromY * height;
  const y2 = segment.toY * height;
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const ymid = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${ymid}, ${x2} ${ymid}, ${x2} ${y2}`;
};

export function GraphCell({
  row,
  columns,
  height,
  selected,
}: {
  readonly row: GraphRow;
  /** Shared lane count across the list, so node columns align between rows. */
  readonly columns: number;
  readonly height: number;
  readonly selected: boolean;
}) {
  const width = Math.max(columns, 1) * LANE_WIDTH;
  const nodeX = laneX(row.lane);
  const nodeY = height / 2;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0"
      shapeRendering="geometricPrecision"
      aria-hidden="true"
    >
      {row.segments.map((segment, index) => (
        <path
          key={index}
          d={segmentPath(segment, height)}
          fill="none"
          style={{ stroke: stroke(segment.color) }}
          strokeWidth={selected ? 2 : 1.5}
        />
      ))}
      <circle
        cx={nodeX}
        cy={nodeY}
        r={selected ? NODE_RADIUS + 1 : NODE_RADIUS}
        style={{ fill: stroke(row.color) }}
        stroke="var(--color-background)"
        strokeWidth={1.5}
      />
    </svg>
  );
}
