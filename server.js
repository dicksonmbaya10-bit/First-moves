/**
 * Serveur "First moves" — sert le site ET gère le jeu en ligne.
 *
 * Ce que ce fichier fait :
 *  - sert le site First moves (index.html) à l'adresse principale du serveur
 *  - reçoit les connexions des joueurs (WebSocket)
 *  - met en relation deux joueurs qui cherchent une partie dans la même cadence
 *  - gère les invitations privées par code (pour jouer avec un ami précis)
 *  - relaie les coups joués entre les deux joueurs d'une partie
 *  - expose un petit tableau de bord humain sur "/admin" (pour toi, pas pour les joueurs)
 *
 * Comment le déployer (Render, gratuit) :
 *  1. Dans ton dépôt GitHub, mets TROIS fichiers côte à côte :
 *       - server.js (ce fichier)
 *       - package.json (fourni à côté)
 *       - index.html (le site First moves — renomme le fichier téléchargé en index.html)
 *  2. Sur render.com : "New +" -> "Web Service" -> relie ton dépôt GitHub.
 *  3. Build Command :  npm install
 *     Start Command :  node server.js
 *  4. Une fois déployé, Render te donne une adresse du type
 *     https://ton-service.onrender.com
 *     — ouvre cette adresse dans un navigateur : c'est directement le site.
 *  5. Pour activer "Jouer en ligne" sur ce site, va dans Paramètres -> Serveur
 *     en ligne, et colle la MÊME adresse en remplaçant https par wss :
 *     wss://ton-service.onrender.com
 *  6. Le tableau de bord (pour surveiller ce qui se passe) reste disponible à
 *     part, sur https://ton-service.onrender.com/admin
 *
 * Rien de tout ça n'est branché à une vraie base de données : les parties et
 * les scores vivent en mémoire et sont perdus si le serveur redémarre. C'est
 * volontairement simple, pensé pour un premier test avec un ami.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

// ---------------------------------------------------------------------------
// Le site lui-même (index.html) : lu une fois au démarrage, servi tel quel.
// ---------------------------------------------------------------------------
const SITE_PATH = path.join(__dirname, "index.html");
let siteHtml = null;
try {
  siteHtml = fs.readFileSync(SITE_PATH, "utf8");
} catch (e) {
  console.warn("index.html introuvable à côté de server.js — le site ne pourra pas être servi tant qu'il n'est pas ajouté au dépôt.");
}

// ---------------------------------------------------------------------------
// État du serveur, gardé en mémoire (voir la remarque ci-dessus)
// ---------------------------------------------------------------------------

const joueurs = new Map();       // ws -> { pseudo, cadence, elo, gameId }
const filesAttente = { bullet: [], blitz: [], rapide: [], classique: [] };
const invitations = new Map();   // code -> { ws, pseudo, cadence }
const parties = new Map();       // gameId -> { blanc, noir, cadence, debut }
const activite = [];             // petit journal des derniers événements

let compteurParties = 0;

function log(msg) {
  const ligne = "[" + new Date().toISOString().slice(11, 19) + "] " + msg;
  console.log(ligne);
  activite.unshift(ligne);
  if (activite.length > 80) activite.pop();
}

function envoyer(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function codeInvitation() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sans lettres/chiffres ambigus
  let c = "";
  for (let i = 0; i < 6; i++) c += chars[(Math.random() * chars.length) | 0];
  return c;
}

// ---------------------------------------------------------------------------
// Mise en relation de deux joueurs
// ---------------------------------------------------------------------------

function demarrerPartie(wsA, wsB, cadence) {
  const infoA = joueurs.get(wsA);
  const infoB = joueurs.get(wsB);
  const gameId = "g" + (++compteurParties);

  // couleur tirée au sort
  const aEstBlanc = Math.random() < 0.5;
  const blanc = aEstBlanc ? wsA : wsB;
  const noir = aEstBlanc ? wsB : wsA;

  parties.set(gameId, { blanc, noir, cadence, debut: Date.now() });
  infoA.gameId = gameId;
  infoB.gameId = gameId;

  envoyer(blanc, {
    type: "match_found",
    color: "w",
    cadence,
    opponentName: joueurs.get(noir).pseudo,
  });
  envoyer(noir, {
    type: "match_found",
    color: "b",
    cadence,
    opponentName: joueurs.get(blanc).pseudo,
  });

  log(
    "Partie " + gameId + " démarrée (" + cadence + ") : " +
    infoA.pseudo + " vs " + infoB.pseudo
  );
}

function chercherAdversaire(ws, cadence) {
  const file = filesAttente[cadence];
  if (!file) return;

  // retire ce joueur de toute file où il serait déjà (au cas où il change de cadence)
  for (const c in filesAttente) {
    const idx = filesAttente[c].indexOf(ws);
    if (idx !== -1) filesAttente[c].splice(idx, 1);
  }

  if (file.length > 0) {
    const adversaire = file.shift();
    if (adversaire.readyState === WebSocket.OPEN) {
      demarrerPartie(ws, adversaire, cadence);
      return;
    }
  }
  file.push(ws);
  log(joueurs.get(ws).pseudo + " cherche une partie en " + cadence);
}

// ---------------------------------------------------------------------------
// Serveur HTTP : sert le tableau de bord admin sur "/", et accepte les
// connexions WebSocket sur le même port (nécessaire pour un hébergeur gratuit
// qui n'ouvre qu'un seul port).
// ---------------------------------------------------------------------------

const serveurHttp = http.createServer((req, res) => {
  if (req.url === "/admin") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pageAdmin());
    return;
  }
  if (req.url === "/" || req.url === "/index.html") {
    if (siteHtml) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(siteHtml);
    } else {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<h1>index.html manquant</h1><p>Ajoute le fichier index.html (le site First moves) " +
        "à côté de server.js dans ton dépôt GitHub, puis redéploie. " +
        "En attendant, le tableau de bord reste disponible sur <a href='/admin' style='color:#9fd'>/admin</a>.</p>"
      );
    }
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});

function pageAdmin() {
  const listeJoueurs = [...joueurs.values()]
    .map((j) => "<tr><td>" + esc(j.pseudo) + "</td><td>" + (j.gameId ? "en partie" : "connecté") + "</td></tr>")
    .join("");
  const listeParties = [...parties.entries()]
    .map(([id, p]) => {
      const nomBlanc = joueurs.get(p.blanc) ? joueurs.get(p.blanc).pseudo : "?";
      const nomNoir = joueurs.get(p.noir) ? joueurs.get(p.noir).pseudo : "?";
      const duree = Math.round((Date.now() - p.debut) / 1000);
      return "<tr><td>" + id + "</td><td>" + esc(nomBlanc) + " vs " + esc(nomNoir) + "</td><td>" + p.cadence + "</td><td>" + duree + "s</td></tr>";
    })
    .join("");
  const journal = activite.map((l) => esc(l)).join("<br>");

  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8">
<title>First moves — tableau de bord</title>
<meta http-equiv="refresh" content="5">
<style>
body{background:#13201A;color:#F1E9D8;font-family:ui-monospace,monospace;padding:24px}
h1{font-family:sans-serif}
table{border-collapse:collapse;margin:12px 0 24px;width:100%;max-width:700px}
td,th{border-bottom:1px solid #2A3A2E;padding:6px 10px;text-align:left;font-size:14px}
.kpi{font-size:32px;font-weight:bold}
.row{display:flex;gap:24px;margin-bottom:24px}
.journal{background:#0F1710;padding:12px;border-radius:8px;max-height:300px;overflow-y:auto;font-size:12px;max-width:700px}
</style></head><body>
<h1>♞ First moves — tableau de bord</h1>
<p style="opacity:.6">Se rafraîchit automatiquement toutes les 5 secondes.</p>
<div class="row">
  <div><div class="kpi">${joueurs.size}</div>personnes connectées</div>
  <div><div class="kpi">${parties.size}</div>parties en cours</div>
  <div><div class="kpi">${compteurParties}</div>parties jouées depuis le démarrage</div>
</div>
<h3>Joueurs connectés</h3>
<table><tr><th>Pseudo</th><th>Statut</th></tr>${listeJoueurs || "<tr><td colspan=2>Personne pour l'instant.</td></tr>"}</table>
<h3>Parties en cours</h3>
<table><tr><th>ID</th><th>Joueurs</th><th>Cadence</th><th>Durée</th></tr>${listeParties || "<tr><td colspan=4>Aucune partie en cours.</td></tr>"}</table>
<h3>Activité récente</h3>
<div class="journal">${journal || "Rien pour l'instant."}</div>
</body></html>`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---------------------------------------------------------------------------
// WebSocket : un joueur par connexion
// ---------------------------------------------------------------------------

const wss = new WebSocket.Server({ server: serveurHttp });

wss.on("connection", (ws) => {
  joueurs.set(ws, { pseudo: "Joueur", cadence: null, elo: 1000, gameId: null });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      return;
    }
    const info = joueurs.get(ws);
    if (!info) return;

    if (msg.type === "find_match") {
      info.pseudo = String(msg.pseudo || "Joueur").slice(0, 24);
      info.elo = Number(msg.elo) || 1000;
      chercherAdversaire(ws, msg.cadence);
      return;
    }

    if (msg.type === "create_invite") {
      info.pseudo = String(msg.pseudo || "Joueur").slice(0, 24);
      const code = codeInvitation();
      invitations.set(code, { ws, pseudo: info.pseudo, cadence: msg.cadence });
      envoyer(ws, { type: "invite_created", code });
      log(info.pseudo + " a créé une invitation (" + code + ")");
      return;
    }

    if (msg.type === "join_invite") {
      info.pseudo = String(msg.pseudo || "Joueur").slice(0, 24);
      const inv = invitations.get(String(msg.code || "").toUpperCase());
      if (!inv || inv.ws.readyState !== WebSocket.OPEN) {
        envoyer(ws, { type: "invite_error", reason: "Code invalide ou expiré." });
        return;
      }
      invitations.delete(String(msg.code).toUpperCase());
      demarrerPartie(inv.ws, ws, inv.cadence);
      return;
    }

    // pendant une partie : coup joué, message de fin, etc. -> relayé tel quel
    // à l'adversaire, First moves gère la légalité des coups de son côté.
    if (["move", "resign", "chat", "draw_offer"].includes(msg.type)) {
      if (!info.gameId) return;
      const partie = parties.get(info.gameId);
      if (!partie) return;
      const adversaire = partie.blanc === ws ? partie.noir : partie.blanc;
      envoyer(adversaire, msg);
      if (msg.type === "resign") {
        log("Partie " + info.gameId + " terminée (abandon).");
        parties.delete(info.gameId);
      }
      return;
    }
  });

  ws.on("close", () => {
    const info = joueurs.get(ws);
    if (info) {
      // retire des files d'attente
      for (const c in filesAttente) {
        const idx = filesAttente[c].indexOf(ws);
        if (idx !== -1) filesAttente[c].splice(idx, 1);
      }
      // prévient l'adversaire si une partie était en cours
      if (info.gameId) {
        const partie = parties.get(info.gameId);
        if (partie) {
          const adversaire = partie.blanc === ws ? partie.noir : partie.blanc;
          envoyer(adversaire, { type: "opponent_disconnected" });
          parties.delete(info.gameId);
        }
      }
      log(info.pseudo + " s'est déconnecté.");
    }
    joueurs.delete(ws);
  });
});

const PORT = process.env.PORT || 3000;
serveurHttp.listen(PORT, () => {
  log("Serveur First moves démarré sur le port " + PORT);
});
