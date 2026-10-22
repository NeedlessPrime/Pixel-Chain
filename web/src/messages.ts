import { ApiRequestError } from './api';
import { fmtInt } from './format';
import type { PlaceFailure } from './socket';

/** An error whose message is already French and fit to show as is. */
export class UserFacingError extends Error {}

/** French toast for a failed placement: the server's own message when it sent one. */
export function placeErrorMessage(f: PlaceFailure, minHolding: number, symbol: string): string {
  if (f.message) return f.message;
  switch (f.code) {
    case 'unauthenticated':
      return 'Session expirée : reconnecte ton wallet.';
    case 'cooldown':
      return 'Pas encore ! Attends la fin du délai.';
    case 'not_holder':
      return `Achète au moins ${fmtInt(minHolding)} ${symbol} pour jouer.`;
    case 'banned':
      return 'Ce wallet est banni.';
    case 'frozen':
      return 'La saison est terminée.';
    case 'out_of_bounds':
      return 'Cette case est hors de la toile.';
    case 'bad_color':
      return 'Couleur invalide.';
    case 'rate_limited':
      return 'Doucement ! Trop de requêtes.';
    case 'rpc_unavailable':
      return 'Solana ne répond pas, réessaie dans un instant.';
    case 'timeout':
      return 'Le serveur n’a pas répondu, pixel annulé.';
    case 'disconnected':
      return 'Connexion perdue, pixel annulé.';
    default:
      return 'Erreur serveur, réessaie.';
  }
}

/** French message for any error thrown by an API call or the wallet (the server's own text first). */
export function errorMessage(err: unknown): string {
  if (err instanceof UserFacingError) return err.message;
  if (err instanceof ApiRequestError) {
    if (err.message) return err.message;
    switch (err.status) {
      case 401:
        return 'Session expirée : reconnecte ton wallet.';
      case 403:
        return 'Action refusée.';
      case 404:
        return 'Introuvable.';
      case 429:
        return 'Trop de requêtes, réessaie dans un instant.';
      default:
        return err.status >= 500 ? 'Erreur serveur, réessaie.' : 'Requête refusée.';
    }
  }
  return 'Une erreur inattendue est survenue.';
}
