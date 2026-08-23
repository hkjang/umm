import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Text } from '@mantine/core';
import { useTranslation } from '../i18n';

export interface ClusterNodeData extends Record<string, unknown> {
  label: string;
  count: number;
  /** What grouped these notes — 'meaning' when umm read them, 'proximity' when it read the layout. */
  basis: 'meaning' | 'proximity';
}

/**
 * A group of thoughts, drawn as one shape.
 *
 * This replaces the notes themselves when the canvas is zoomed out far enough
 * that individual text is unreadable anyway. The count is the point: it says how
 * much is inside without pretending the contents are legible.
 *
 * The basis is shown rather than assumed. Grouping by meaning and grouping by
 * where things were placed are different claims, and someone deciding whether to
 * trust the shape of their workspace needs to know which one they are looking at.
 */
export default function ClusterNode({ data }: NodeProps) {
  const { t } = useTranslation();
  const cluster = data as ClusterNodeData;
  return (
    <div className={`cluster-node cluster-${cluster.basis}`}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Text className="cluster-count" fw={700}>
        {cluster.count}
      </Text>
      <Text className="cluster-label" lineClamp={2}>
        {cluster.label}
      </Text>
      <Text className="cluster-basis" size="xs">
        {cluster.basis === 'meaning' ? t('내용으로 묶임') : t('가까이 둔 것으로 묶임')}
      </Text>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}
