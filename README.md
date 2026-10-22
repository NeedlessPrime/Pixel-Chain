# $PIXEL — la toile géante partagée

Une pixel war façon r/place pour les holders du coin **$PIXEL** sur Solana.
Tu connectes ton wallet (Phantom, Solflare, Backpack…), et plus tu gardes de
$PIXEL, plus tu poses de pixels souvent. Chaque saison dure une semaine, puis la
toile est figée, signée du logo $PIXEL et part au Hall of Fame avec sa timelapse.

## Les règles

| | |
|---|---|
| **Qui joue** | Tout wallet qui garde au moins **10 000 $PIXEL** |
| **Cadence** | ≥ 1 M → 1 pixel / **5 s** · ≥ 100 k → 1 pixel / **30 s** · ≥ 10 k → 1 pixel / **minute** (jamais plus lent : **une minute max**) |
| **Signature** | Une seule signature gratuite à la connexion (aucune transaction, aucun frais). Ensuite on pose sans popup |
| **Anti-triche** | Le solde est relu sur la blockchain (toutes les 30 s) : si tu revends, tu perds ta cadence |
| **Saison** | 7 jours. Les dernières 24 h = **mode CHAOS** : cadence ×2 pour tout le monde |
| **Fin de saison** | La toile est figée, **le logo $PIXEL est posé en bas à droite**, l'image et la timelapse partent au **Hall of Fame**, puis nouvelle saison, nouveau thème, toile vide |
| **Factions** | Chaque joueur peut rejoindre une faction ; le classement montre qui contrôle le plus de pixels |
| **Récompenses** | Du statut et de la visibilité. **Aucun prix en argent** (sinon c'est une loterie) |
| **Modération** | Bouton « Signaler » pour les joueurs ; page `/admin` pour effacer une zone, bannir un wallet, gérer les saisons |

Tous ces chiffres se règlent par variables d'environnement (voir `.env.example`).

## Lancer en local (mode test, soldes fictifs)

```bash
npm install
cp .env.example .env          # MODE=mock, ADMIN_TOKEN=change-me
npm run dev                   # serveur :8787 + site :5173
```

Ouvre http://localhost:5173. En mode test, choisis **« Dev wallet (test) »** (ou
ton vrai Phantom) et règle ton solde fictif dans le bandeau pour essayer chaque palier.
La modération est sur http://localhost:5173/admin.html (jeton = `ADMIN_TOKEN`).

## Passer en vrai au lancement du coin

```env
MODE=live
TOKEN_MINT=<adresse du mint $PIXEL>
SOLANA_RPC_URL=<RPC payant, ex. Helius>   # le RPC public est vite limité
ADMIN_TOKEN=<long secret aléatoire>
```

Le bouton « Acheter $PIXEL » pointe automatiquement vers `https://pump.fun/coin/<mint>`.
Pour signer les toiles avec ton propre logo, dépose un PNG à fond transparent dans
`server/assets/logo.png` (les couleurs sont ramenées à la palette).

## Déployer

```bash
docker build -t pixel .
docker run -d -p 8787:8787 -v pixel-data:/data --env-file .env pixel
```

Un seul conteneur sert le site, l'API et le temps réel (WebSocket). Tout l'état
(toile, saisons, Hall of Fame) est dans le volume `/data`. Mets un reverse proxy
HTTPS devant (Caddy, Nginx, Cloudflare) — les wallets exigent HTTPS.

## Structure

```
shared/   règles communes : palette, paliers, message de connexion, protocole, format timelapse
server/   Node 22 + Fastify + WebSocket : soldes Solana, cooldowns, saisons, archives, modération
web/      Vite + TypeScript : toile, wallets, HUD, Hall of Fame, admin
docs/ARCHITECTURE.md   le contrat technique complet (API, messages temps réel, persistance)
```

```bash
npm run typecheck   # types partout
npm test            # tests unitaires et d'intégration
```
