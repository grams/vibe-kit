-- vibe-kit : tables du socle (préfixe kit_). Ne jamais modifier depuis une app.

create table if not exists "kit_user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);

create table if not exists "kit_session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "kit_user" ("id") on delete cascade);

create table if not exists "kit_account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "kit_user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);

create table if not exists "kit_verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);

create index if not exists "kit_session_userId_idx" on "kit_session" ("userId");

create index if not exists "kit_account_userId_idx" on "kit_account" ("userId");

create index if not exists "kit_verification_identifier_idx" on "kit_verification" ("identifier");

-- Réglages du socle (clé/valeur JSON) : mode d'accès, domaines autorisés…
create table if not exists "kit_settings" ("key" text not null primary key, "value" text not null, "updatedAt" date not null);

-- Invitations : emails autorisés à créer un compte en mode restreint.
create table if not exists "kit_invitation" ("email" text not null primary key, "invitedBy" text references "kit_user" ("id") on delete set null, "createdAt" date not null, "acceptedAt" date);
