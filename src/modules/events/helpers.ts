export { neutraliserMentions as neutralizeMentions, tronquer as truncate } from '../../core/text';

export function listeMentionsCourte(ids: string[], max: number): string {
  const affiches = ids.slice(0, max).map((id) => `<@${id}>`).join(' ');
  return ids.length > max ? `${affiches} +${ids.length - max}` : affiches;
}
