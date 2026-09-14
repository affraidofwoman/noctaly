/** Erreur destinée à l'utilisateur : son message est affiché tel quel. */
export class UserError extends Error {
  constructor(
    message: string,
    public readonly title = '❌ Action impossible',
  ) {
    super(message);
    this.name = 'UserError';
  }
}

export const GENERIC_ERROR = "Le bot n'a pas pu effectuer cette action.";

/** Codes d'erreur Discord courants traduits en messages compréhensibles. */
export function describeDiscordError(err: unknown): string | null {
  const code = (err as { code?: number } | null)?.code;
  switch (code) {
    case 50013:
      return "Je n'ai pas les permissions nécessaires (vérifie mes permissions et la position de mon rôle).";
    case 50001:
      return "Je n'ai pas accès à ce salon.";
    case 50007:
      return "Impossible d'envoyer un message privé à cet utilisateur.";
    case 10007:
      return 'Ce membre est introuvable sur le serveur.';
    case 10008:
      return 'Ce message est introuvable (peut-être supprimé).';
    case 10003:
      return 'Ce salon est introuvable.';
    case 10011:
      return 'Ce rôle est introuvable.';
    case 30005:
      return 'Le serveur a atteint la limite de rôles.';
    case 30013:
      return 'Le serveur a atteint la limite de salons.';
    case 50035:
      return 'Certaines valeurs fournies sont invalides.';
    default:
      return null;
  }
}
