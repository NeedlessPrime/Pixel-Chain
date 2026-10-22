import { MAX_CANVAS_SIZE, type PlaceErrorCode } from '@pixel/shared';
import { MAX_OPEN_REPORTS_PER_WALLET } from './reports';

/* User-facing texts (French). Codes stay English; only `message` strings live here. */

const numberFormat = new Intl.NumberFormat('fr-FR');

/** 10000 -> "10 000": the narrow no-break spaces of fr-FR become plain spaces. */
export function formatAmount(n: number): string {
  return numberFormat.format(n).replace(/\s/g, ' ');
}

export interface PlaceMessageContext {
  now: number;
  nextPlaceAt?: number;
  /** Balance of the lowest tier. */
  minBalance: number;
  symbol: string;
}

export function placeErrorMessage(code: PlaceErrorCode, ctx: PlaceMessageContext): string {
  switch (code) {
    case 'unauthenticated': return 'Connecte ton wallet pour poser un pixel';
    case 'frozen': return 'La saison est terminée, rendez-vous à la prochaine !';
    case 'out_of_bounds': return 'Ce pixel est hors de la toile';
    case 'bad_color': return 'Couleur invalide';
    case 'banned': return 'Ce wallet est banni';
    case 'not_holder': return `Achète au moins ${formatAmount(ctx.minBalance)} ${ctx.symbol} pour jouer`;
    case 'cooldown': return `Attends encore ${Math.max(1, Math.ceil(((ctx.nextPlaceAt ?? ctx.now) - ctx.now) / 1000))} s`;
    case 'rate_limited': return 'Doucement ! Trop de messages';
    case 'rpc_unavailable': return 'Impossible de lire ton solde, réessaie dans un instant';
    case 'internal': return 'Erreur interne, réessaie';
  }
}

export const HTTP_MESSAGES = {
  bad_request: 'Requête invalide',
  bad_wallet: 'Adresse de wallet invalide',
  invalid_nonce: 'Demande de connexion expirée ou déjà utilisée, recommence',
  bad_signature: 'Signature invalide',
  unauthenticated: 'Connecte ton wallet pour continuer',
  forbidden: 'Accès refusé',
  admin_disabled: "L'administration est désactivée sur ce serveur",
  not_found: 'Introuvable',
  bad_faction: 'Nom de faction invalide (2 à 16 lettres, chiffres, espaces, $ _ . -)',
  too_many_reports: `Tu as déjà ${MAX_OPEN_REPORTS_PER_WALLET} signalements en attente`,
  rate_limited: 'Trop de requêtes, réessaie dans un instant',
  season_live: 'La saison est encore en cours',
  season_frozen: 'La saison est déjà terminée',
  bad_size: `Taille invalide : la toile peut seulement grandir (${MAX_CANVAS_SIZE} max)`,
  internal: 'Erreur interne',
} as const;

export function factionLockedMessage(lockedUntil: number, now: number): string {
  return `Tu pourras changer de faction dans ${Math.max(1, Math.ceil((lockedUntil - now) / 60_000))} min`;
}
