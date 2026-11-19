# LonaPics — version web gratuite

*Tous vos souvenirs, au même endroit. ❤️*

Une appli web à ajouter sur l'écran d'accueil de vos téléphones. Elle s'ouvre en plein écran, comme une vraie appli. Pas d'App Store, pas de Play Store, 0 €.

Tout est gratuit :
- **Supabase** (offre gratuite) pour les comptes, la base de données et le stockage des photos
- **GitHub Pages** pour héberger le site

Compte environ 20 minutes la première fois.

---

## Étape 1 : créer la base Supabase

1. Va sur **supabase.com**, crée un compte gratuit puis **New project**. Nom : `lonapics`, région : Europe (Paris ou Francfort). Note bien le mot de passe de la base.
2. Une fois le projet prêt, ouvre **SQL Editor** puis **New query**.
3. Ouvre le fichier `supabase/schema.sql`, copie **tout** son contenu, colle-le et appuie sur **Run**. Tu dois voir « Success ».
4. Va dans **Project Settings → API** (ou le bouton **Connect**) et copie :
   - le **Project URL** (du type `https://abcd1234.supabase.co`)
   - la clé **anon** / **publishable**
5. Ouvre `config.js` et colle ces deux valeurs à la place de `TON-PROJET…` et `COLLE-ICI…`.

> La clé anon est faite pour être publique. Ce sont les règles de sécurité du fichier SQL qui protègent les photos : un espace n'est visible que par ses membres.

## Étape 2 : mettre le site en ligne (GitHub Pages)

1. Crée un compte gratuit sur **github.com**.
2. **New repository**, nom : `lonapics`, en **Public**, puis **Create**.
3. Sur la page du dépôt : **Add file → Upload files**. Glisse **tout le contenu** du dossier `lonapics-web` (les fichiers et les dossiers `icons` et `supabase`), puis **Commit changes**.
4. **Settings → Pages**. Dans « Branch », choisis `main` et `/ (root)`, puis **Save**.
5. Après une à deux minutes, ton site est en ligne à l'adresse `https://TON-PSEUDO.github.io/lonapics/`.

## Étape 3 : relier Supabase à ton adresse

Dans Supabase, va dans **Authentication → URL Configuration** :
- **Site URL** : `https://TON-PSEUDO.github.io/lonapics/`
- **Redirect URLs** : ajoute la même adresse.

C'est indispensable pour que les liens des e-mails de confirmation ramènent dans l'appli.

> L'offre gratuite de Supabase n'envoie que quelques e-mails par heure. Si tu veux éviter la confirmation par e-mail, désactive **Confirm email** dans **Authentication → Sign In / Providers → Email**.

## Étape 4 : installer sur vos téléphones

**iPhone (Safari obligatoire)** : ouvre l'adresse, touche **Partager** (le carré avec la flèche), puis **Sur l'écran d'accueil**.

**Android (Chrome)** : ouvre l'adresse, touche le menu **⋮**, puis **Ajouter à l'écran d'accueil** ou **Installer l'application**.

Ensuite, Lorenzo crée un compte et un espace « Lorenzo et Tina ❤️ », et touche **Inviter** pour envoyer le lien à Tina. Tina crée son compte depuis ce lien et arrive directement dans l'espace.

---

## Étape 5 : notifications et rappels du calendrier

Ça permet de recevoir « Tina vient d'envoyer une photo » ou « ⏰ Resto dans 1 h » même quand l'appli est fermée.

> Si tu avais déjà lancé une ancienne version de `schema.sql`, relance la nouvelle en entier. Elle peut être lancée plusieurs fois sans rien casser.

1. **Créer la fonction d'envoi.** Dans Supabase, ouvre **Edge Functions → Deploy a new function → Via Editor**. Nomme-la exactement `notify`, colle tout le contenu de `supabase/functions/notify/index.ts`, puis **Deploy**.
2. **Désactiver la vérification JWT.** Dans les réglages de la fonction `notify`, désactive **Verify JWT** (« Enforce JWT verification »). La fonction vérifie elle-même qui l'appelle.
3. **Ajouter les secrets.** Ouvre **Edge Functions → Secrets** et ajoute les 4 lignes du fichier **A-GARDER-SECRET.txt** (fourni à côté du dossier, pas dedans).
4. **Activer les rappels automatiques.** Ouvre `supabase/rappels-cron.sql` et remplace `TON-PROJET` et `TON-CRON-SECRET` par tes valeurs. Colle-le dans le **SQL Editor**, puis **Run**. Si Supabase signale une extension manquante, active **pg_cron** et **pg_net** dans **Database → Extensions** et relance.
5. **Activer sur chaque téléphone.** Ouvre LonaPics **depuis son icône**, va dans **Profil → Notifications → Activer**, accepte, puis touche **Tester**.

> **iPhone** : il faut iOS 16.4 ou plus récent, et ouvrir LonaPics depuis l'icône de l'écran d'accueil. Depuis Safari, ça ne marche pas : c'est une règle d'Apple.
> **A-GARDER-SECRET.txt ne doit jamais aller sur GitHub.** N'envoie que le contenu du dossier `lonapics-web`.

## Le calendrier

- Rendez-vous avec heure ou sur toute la journée
- Partagés avec un espace (« Lorenzo et Tina ») ou **🔒 perso**, visibles par toi seul
- Rappel : à l'heure, 10 min, 30 min, 1 h, 2 h, 1 jour ou 1 semaine avant. Pour la journée entière : le jour même ou la veille à 9 h
- Répétition chaque semaine, mois ou année (pratique pour les anniversaires)
- Quand quelqu'un ajoute un rendez-vous partagé, les autres membres reçoivent une notification
- Les prochains rendez-vous de la semaine s'affichent aussi sur l'accueil
- Chacun choisit dans son profil les notifications qu'il veut recevoir

## Ce qui fonctionne

- Inscription, connexion, mot de passe oublié
- Espaces privés (nom, icône, couleur), invitations par lien ou par code, quitter ou supprimer un espace
- Envoi de plusieurs photos d'un coup, depuis la galerie ou directement avec l'appareil photo
- Choix de la qualité : originale, haute ou économie
- Réception en direct : quand Tina envoie une photo, elle apparaît tout de suite chez Lorenzo si l'appli est ouverte
- Expéditeur, date et heure de chaque photo, visionneuse plein écran (glisser pour passer d'une photo à l'autre)
- Enregistrement dans la galerie d'une photo ou de plusieurs à la fois
- Suppression de ses photos et de son compte (toutes les données sont effacées)
- Mode clair, sombre ou automatique

## La limite à connaître : l'enregistrement automatique

Pour protéger la vie privée, **un site web ne peut pas écrire dans la galerie sans un geste de l'utilisateur**, ni sur iPhone ni sur Android. Seule une appli des stores en a le droit.

Ce que fait LonaPics à la place, quand « Enregistrement automatique » est activé : dès qu'une photo arrive, ou dès que tu ouvres l'appli, une fenêtre propose toutes les nouvelles photos d'un coup. Il suffit d'**un seul toucher** :
- **iPhone** : « Enregistrer dans ma galerie », puis « Enregistrer les images ». Les photos vont dans l'app Photos.
- **Android** : « Enregistrer dans ma galerie ». Les photos sont téléchargées et apparaissent dans la galerie (album « Download »). Chrome peut demander une fois d'autoriser plusieurs téléchargements.

## Bon à savoir sur l'offre gratuite

- Stockage limité (de l'ordre de 1 Go). En qualité « Haute », ça représente plusieurs centaines de photos.
- Si personne n'utilise l'appli pendant une semaine, Supabase met le projet en pause. Il suffit de le réactiver d'un clic depuis le tableau de bord.
