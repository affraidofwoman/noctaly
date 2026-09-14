export { neutralizeMentions, truncate } from '../../core/text';

export function mentionListShort(ids: string[], max: number): string {
  const shown = ids.slice(0, max).map((id) => `<@${id}>`).join(' ');
  return ids.length > max ? `${shown} +${ids.length - max}` : shown;
}
