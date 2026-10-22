# Mettre $PIXEL en ligne avec Railway

## En bref : Railway suffit-il ?

**Oui**, pour le lancement et bien au-delà, à deux conditions : **ajouter un volume
monté sur `/data`** et **mettre `TRUST_PROXY=1`**. Tout le reste est prêt dans le
dépôt (`Dockerfile` + `railway.json`).

| Ce dont le jeu a besoin | Sur Railway |
|---|---|
| Un serveur Node toujours allumé (la toile vit en mémoire) | Un service Railway, sans mise en veille |
| Un disque qui survit aux mises à jour (toile, saisons, Hall of Fame) | Un **volume** monté sur `/data` — **obligatoire** |
| Le temps réel (WebSocket) | Supporté. Si Railway coupe une connexion, le site se reconnecte et se resynchronise tout seul |
| HTTPS (les wallets l'exigent) | Automatique, sur `xxx.up.railway.app` ou ton domaine |
| La vraie IP des joueurs (limites anti-spam) | `TRUST_PROXY=1` |
| Lire les soldes $PIXEL sur Solana | **Pas Railway** : il faut un RPC (Helius), voir plus bas |

Ce qu'il faut savoir :

- **Un seul serveur.** Le jeu est conçu pour tourner sur une seule machine (et
  Railway n'autorise de toute façon qu'une instance avec un volume). Une instance
  tient plusieurs milliers de joueurs connectés en même temps : en test, 5 000
  connexions occupent environ 72 Mo de RAM et un pixel arrive chez tout le monde en
  ~0,1 s. Au-delà d'environ 10 000 joueurs simultanés, il faudrait revoir l'architecture.
- **Quelques secondes de coupure à chaque mise à jour.** Avec un volume, Railway
  arrête l'ancien serveur avant de démarrer le nouveau. Le serveur sauvegarde la
  toile en s'arrêtant et les joueurs se reconnectent automatiquement. Évite juste de
  mettre à jour pendant les dernières heures d'une saison.

## Combien ça coûte

Tarifs publiés par Railway au moment d'écrire (à revérifier sur railway.com/pricing) :
plan **Hobby à 5 $/mois, qui inclut 5 $ d'usage**, puis RAM 10 $/Go/mois,
CPU 20 $/vCPU/mois, trafic sortant 0,05 $/Go, volume 0,15 $/Go/mois.

Le RPC Helius se paie à part. Une lecture de solde coûte 1 crédit ; le serveur relit
le solde d'un joueur au plus une fois toutes les 30 s, et seulement quand il pose un pixel.

| Situation | Railway | Helius |
|---|---|---|
| Tests entre potes (mode test, soldes fictifs) | ~5 $/mois (couvert par le plan) | rien (pas de RPC en mode test) |
| Lancement : ~100 joueurs actifs en continu | ~10 à 20 $/mois | plan Developer, 10 M crédits/mois |
| Gros succès : ~1 000 joueurs actifs en continu | ~50 à 150 $/mois, surtout du trafic sortant | Developer + crédits en plus |

Ce sont des ordres de grandeur : le trafic dépend du nombre de joueurs connectés et
de la vitesse à laquelle ils posent. Le plan gratuit de Helius (1 M crédits/mois)
suffit pour tester avec quelques personnes, pas pour un lancement.

Astuce : `BALANCE_TTL_MS=60000` divise par deux la consommation RPC (en contrepartie,
un joueur qui revend garde sa cadence jusqu'à une minute de plus).

## Pas à pas

### 1. Créer le service

1. Crée un compte sur Railway et passe au plan **Hobby**.
2. **New Project → Deploy from GitHub repo →** `NeedlessPrime/Pixel-Chain`, branche **`main`**.
3. Railway lit `railway.json` et construit le `Dockerfile` tout seul.

### 2. Ajouter le volume (obligatoire)

Dans le projet, ajoute un **Volume** au service (clic droit sur le service →
*Attach volume*, ou la palette de commandes) avec le chemin de montage :

```
/data
```

Sans volume, **la toile, les saisons et le Hall of Fame sont effacés à chaque mise
à jour**. Le serveur l'écrit en gros dans les logs s'il ne trouve pas le volume.

### 3. Les variables (onglet *Variables*)

**Phase de test** (soldes fictifs, avant que le coin existe) :

```env
ADMIN_TOKEN=<colle ici le résultat de : openssl rand -hex 24>
TRUST_PROXY=1
RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15
```

- `ADMIN_TOKEN` ouvre la page `/admin` (16 caractères minimum, sinon le serveur refuse de démarrer).
- `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` laisse au serveur le temps de sauvegarder la toile à chaque mise à jour.
- Ne mets **ni `PORT`** (Railway le fournit) **ni `DATA_DIR`** (déjà `/data` dans l'image).

**Au lancement du coin**, ajoute :

```env
TOKEN_MINT=<adresse du mint $PIXEL>
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=<ta clé Helius>
RPC_MAX_RPS=40
```

- Avec `TOKEN_MINT`, le serveur passe tout seul en mode réel (`MODE=live`).
- `RPC_MAX_RPS` : un peu moins que la limite de ton plan Helius (Developer : 50 req/s → 40 ; gratuit : 10 → 8).
- Optionnel : `SESSION_SECRET=<openssl rand -hex 32>`. Sinon il est généré et gardé dans le volume.
- Les autres réglages (paliers, durée des saisons, thèmes, factions…) sont listés dans `.env.example`.

### 4. Le domaine

*Settings → Networking → Generate Domain* donne une adresse `https://xxx.up.railway.app`.
Pour ton propre domaine : *Custom Domain*, puis un enregistrement CNAME chez ton
registrar. Si tu utilises Cloudflare, laisse le nuage **gris (DNS only)** : avec le
proxy Cloudflare devant Railway, il y a deux proxys et `TRUST_PROXY=1` ne suffit plus.

### 5. Vérifier que tout marche

1. `https://<ton-domaine>/api/health` répond `{"ok":true}`.
2. Dans les logs : la ligne `$PIXEL server listening … mode=… admin=enabled`, et **aucune ligne avec `!!!`**.
3. Ouvre le site, connecte un wallet. Sur téléphone, ouvre le site **dans le navigateur
   de l'app Phantom** (le site propose le bouton). En mode test, mets-toi un solde
   fictif dans le bandeau jaune et pose un pixel.
4. Ouvre `https://<ton-domaine>/admin` avec ton `ADMIN_TOKEN`.

### 6. Le jour du lancement

1. Pour repartir d'une **Saison 1 toute propre**, sans les dessins de test :
   supprime le volume et recrées-en un sur `/data` (ou bien, dans `/admin`,
   « Terminer la saison » puis « Démarrer la suivante », mais la saison de test
   restera alors dans le Hall of Fame).
2. Ajoute `TOKEN_MINT` et `SOLANA_RPC_URL`, puis laisse Railway redéployer.
3. Dans les logs : `mode=live`, et aucune ligne `!!!`.
4. Teste avec un vrai wallet qui détient des $PIXEL, et vérifie que le bouton
   « Acheter » ouvre bien la page pump.fun du coin.

## Mettre à jour

Chaque push sur `main` redéploie automatiquement (quelques secondes de coupure,
les joueurs se reconnectent). Évite les dernières heures d'une saison.

## Problèmes fréquents

| Symptôme | Cause et solution |
|---|---|
| Logs : `!!! Railway: no volume mounted…` | Ajoute le volume sur `/data` (étape 2) |
| Logs : `Invalid configuration: ADMIN_TOKEN…` | Jeton trop court ou laissé à `change-me` : génère-en un avec `openssl rand -hex 24` |
| Beaucoup de joueurs reçoivent « Trop de requêtes » en même temps | `TRUST_PROXY=1` manque : tout le monde partage la même limite |
| « Impossible de lire ton solde » | Clé Helius fausse, crédits épuisés, ou `RPC_MAX_RPS` au-dessus de ton plan |
| Le site se reconnecte de temps en temps | Normal : Railway coupe parfois les WebSocket longues, le site se resynchronise tout seul |
| La toile a disparu après une mise à jour | Pas de volume, ou volume monté ailleurs que sur `/data` |

## Si ça devient énorme

Au-delà de quelques centaines de joueurs connectés en continu, c'est surtout le
trafic sortant qui coûte. La même image Docker tourne telle quelle sur un petit
serveur loué au mois (de type Hetzner ou OVH, quelques euros par mois avec beaucoup
de trafic inclus) : voir la section « Déployer » du README. On pourra en reparler
si on y arrive.
