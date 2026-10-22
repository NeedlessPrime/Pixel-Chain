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
| **Modération** | Bouton « Signaler » pour les holders ; page `/admin` pour voir qui a dessiné une zone, l'effacer, bannir un wallet, gérer les saisons |

Tous ces chiffres se règlent par variables d'environnement (voir `.env.example`).

**Limite connue :** comme le solde est relu toutes les 30 s par wallet, quelqu'un
qui fait passer les mêmes tokens d'un wallet à l'autre peut cumuler les cadences
pendant ces 30 s. Ça coûte des frais de transaction à chaque transfert et ça reste
marginal face aux vrais holders ; le corriger demanderait de lire l'historique des
transactions de chaque wallet.

## Lancer en local (mode test, soldes fictifs)

```bash
npm install
cp .env.example .env          # sans TOKEN_MINT = mode test (soldes fictifs)
npm run dev                   # serveur :8787 + site :5173
```

Ouvre http://localhost:5173. En mode test, choisis **« Dev wallet (test) »** (ou
ton vrai Phantom) et règle ton solde fictif dans le bandeau pour essayer chaque palier.
Pour la modération, mets dans `.env` un `ADMIN_TOKEN` d'au moins 16 caractères
(par ex. `openssl rand -hex 24`), puis ouvre http://localhost:5173/admin.html avec ce jeton.

## Passer en vrai au lancement du coin

```env
TOKEN_MINT=<adresse du mint $PIXEL>       # passe automatiquement en MODE=live
SOLANA_RPC_URL=<RPC payant, ex. Helius>   # le RPC public est vite limité
ADMIN_TOKEN=<long secret aléatoire>       # openssl rand -hex 24
```

Ne laisse pas `MODE=mock` avec un vrai mint : n'importe qui pourrait s'attribuer
un solde (le serveur l'affiche en gros avertissement au démarrage).

Le bouton « Acheter $PIXEL » pointe automatiquement vers `https://pump.fun/coin/<mint>`.
Pour signer les toiles avec ton propre logo, dépose un PNG à fond transparent dans
`server/assets/logo.png` (les couleurs sont ramenées à la palette).

## Déployer

```bash
docker build -t pixel .
docker run -d -p 127.0.0.1:8787:8787 -v pixel-data:/data --env-file .env pixel
```

Un seul conteneur sert le site, l'API et le temps réel (WebSocket). Tout l'état
(toile, saisons, Hall of Fame) est dans le volume `/data` : ne mets pas de
`DATA_DIR` dans `.env`.

Mets un reverse proxy HTTPS devant (Caddy, Nginx, Cloudflare) — les wallets exigent
HTTPS — et, derrière lui :

- `TRUST_PROXY=1` dans `.env` (le nombre de proxys devant le serveur : `2` si
  Cloudflare est devant ton Nginx), pour que les limites de requêtes voient la vraie
  IP de chaque joueur ;
- le port publié sur localhost seulement (`-p 127.0.0.1:8787:8787`, comme ci-dessus),
  pour que personne ne contourne le proxy : en direct, un client pourrait choisir
  son IP avec l'en-tête `X-Forwarded-For`.

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
