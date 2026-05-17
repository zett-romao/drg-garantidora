# DRG-Garantidora

Plataforma de gestão da **cobrança garantida de contribuições condominiais** da D.R. Global.

Web app em HTML/CSS/JS puro (sem build) + Firebase (Firestore, Auth, Storage) + Cloudflare Workers para integrações. Mesma stack do DRG-Rently.

## O que faz

Automatiza a operação de cobrança garantida: cadastro de condomínios, unidades e condôminos; emissão de boletos; régua de cobrança por atraso; conciliação de pagamentos; antecipação de repasses ao condomínio; gestão da carteira de inadimplentes adquirida; e painel financeiro. Três perfis de acesso: equipe D.R. Global, síndico e condômino.

> O modelo de negócio está documentado em `CLAUDE.md`.

## Configuração (primeira vez)

1. Crie um projeto no [Firebase Console](https://console.firebase.google.com) — **próprio da DRG-Garantidora**, separado do DRG-Rently.
2. Habilite **Authentication** (provedor E-mail/Senha), **Firestore Database** e **Storage**.
3. Em *Configurações do projeto → Seus apps → app Web*, copie o objeto `firebaseConfig`.
4. Cole os valores em **`firebase-config.js`** (substituindo os `PREENCHER`).
5. Aplique as **Security Rules** do Firestore e do Storage — ver `CLAUDE.md`.
6. Crie o primeiro usuário `super_admin` — ver `CLAUDE.md → Bootstrap`.

Enquanto o `firebase-config.js` não estiver preenchido, a tela de login exibe um aviso e o acesso fica bloqueado.

## Rodar localmente

Sirva a pasta por HTTP (não abra via `file://`, o Firebase exige `http`/`https`):

- VS Code: extensão **Live Server**, ou
- `npx serve` na pasta do projeto, ou
- `python -m http.server 8080`

## Deploy

- **Frontend:** GitHub Pages.
- **Workers:** Cloudflare (integração Asaas etc.) — entra na Fase 2.

## Status

**Fase 1** em andamento: fundação, autenticação, perfis, cadastros e importação. Roadmap completo em `CLAUDE.md`.
