# DRG-Garantidora — Notas de Projeto

Memória de contexto pro Claude (ou outra IA) que abrir este projeto. **Leia antes de fazer mudanças relevantes.**

---

## O que é

Plataforma web de gestão da **cobrança garantida de contribuições condominiais** da D.R. Global. Versão controlada por `APP_VERSION` no topo de `app.js` (atualmente `0.1.0`).

### Modelo de negócio

A D.R. Global ("COBRADORA") garante a um condomínio 100% da receita das cotas todo mês, independente de quem pagou; assume o risco da inadimplência e lucra com a cobrança. É antecipação de recebíveis + compra de carteira de inadimplentes.

**Receita da D.R. Global:** (1) taxa de administração de 8% sobre cada antecipação; (2) tarifa de R$ 3,50 por boleto; (3) 100% das multas/juros/correção/encargos pagos pelos inadimplentes; (4) spread na compra de carteira de inadimplentes.

**Régua de cobrança (encargos por atraso):** até o vencimento = valor nominal; 1º–10º dia = multa + juros de mora; 11º–30º dia = + 10% de encargos + 2ª via; 31º dia+ = + INPC + mais 10% de encargos.

**Antecipação/repasse:** mensal, até 2 dias úteis após o vencimento. Valor = nominal líquido − 8% − R$ 3,50/boleto − descontos.

> Os valores (8%, R$ 3,50, régua, gatilhos) variam por contrato — são **parâmetros configuráveis por contrato**, nunca hard-coded. Contrato de referência: Residencial 14 Bis (Cotia/SP).

---

## Stack

- HTML/CSS/JS puro (sem framework, sem build).
- Firebase **10.7.1 compat** — Auth (E-mail/Senha) + Firestore + Storage.
- GitHub Pages (hosting do frontend).
- Cloudflare Workers para integrações (Asaas — boleto + Pix; entra na Fase 2).
- PWA (manifest + service worker).

---

## Estrutura de arquivos

```
.
├── index.html                   # App (login + shell)
├── app.js                       # Toda a lógica
├── styles.css                   # Visual (paleta slate)
├── firebase-config.js           # Config Firebase (placeholders — PREENCHER)
├── firebase-config.template.js  # Template documentado
├── manifest.json / sw.js        # PWA
├── logo.png
├── README.md
└── CLAUDE.md                    # Este arquivo
```

---

## Perfis de acesso (`users/{uid}.role`)

- `super_admin` — equipe D.R. Global com acesso total, inclusive Usuários e Auditoria.
- `operador_drg` — equipe D.R. Global operacional (sem administração de usuários).
- `sindico` — síndico; enxerga só o próprio condomínio (`condominioId`).
- `condomino` — condômino; enxerga só a própria unidade (`condominioId` + `unidadeId`).

Não há cadastro público (signup). Todos os usuários são criados pela equipe D.R. Global.

---

## Modelo de dados (Firestore)

### Top-level

- **`users/{uid}`** — `uid` = Firebase Auth uid.
  - `nome`, `email`, `role`, `ativo` (bool), `criadoEm`.
  - `condominioId` — presente para `sindico` e `condomino`.
  - `unidadeId` — presente para `condomino`.
- **`condominios/{condominioId}`**
  - `nome`, `cnpj`, `endereco{logradouro,numero,complemento,bairro,cidade,uf,cep}`,
    `sindico{nome,cpf,telefone,email}`, `ativo` (bool), `criadoEm`, `criadoPor`.
- **`auditoria/{logId}`** — trilha LGPD (Fase 4). Gravada por Worker.

### Subcoleções de `condominios/{condominioId}`

- `unidades/{unidadeId}` — `identificacao`, `bloco`, `fracaoIdeal`, `condominoId`, `ativa`.
- `condominos/{condominoId}` — `nome`, `cpfCnpj`, `rg`, `telefones[]`, `emails[]`,
  `enderecoCorrespondencia`, `tipo` ('proprietario'|'inquilino'|'responsavel'), `unidadeId`.
- `contratos/{contratoId}` — contrato de cobrança garantida:
  `numero`, `taxaAdmPct`, `tarifaBoleto`, `vigenciaInicio`, `vigenciaFim`, `prazoMeses`,
  `renovacaoAuto`, `avisoDenunciaDias`,
  `regua{multaPct, jurosMoraMesPct, indexador, faixas:[{apartirDias,encargoPct,aplicaCorrecao}]}`,
  `descontoPontualidade`, `carteiraAdquirida{valor, dataCorte, dataPagamento}`,
  `status`, `criadoEm`.
- (Fase 2+) `competencias`, `boletos`, `pagamentos`.
- (Fase 3+) `repasses`, `creditosAdquiridos`.
- (Fase 4)  `cobrancas`, `processos`.

### Storage

```
/condominios/{condominioId}/docs/{file}                       # convenção, atas
/condominios/{condominioId}/condominos/{condominoId}/docs/{file}
/condominios/{condominioId}/contratos/{contratoId}/docs/{file}
```

---

## Security Rules (aplicar no Firebase Console)

**Firestore Database → Rules:**

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function isSignedIn() { return request.auth != null; }
    function userExists() {
      return exists(/databases/$(database)/documents/users/$(request.auth.uid));
    }
    function userDoc() {
      return get(/databases/$(database)/documents/users/$(request.auth.uid)).data;
    }
    function isDRGTeam() {
      return isSignedIn() && userExists()
        && (userDoc().role == 'super_admin' || userDoc().role == 'operador_drg');
    }
    function isSuperAdmin() {
      return isSignedIn() && userExists() && userDoc().role == 'super_admin';
    }
    function isSindicoDe(cid) {
      return isSignedIn() && userExists()
        && userDoc().role == 'sindico' && userDoc().condominioId == cid;
    }
    function meuCondominio(cid) {
      return isSignedIn() && userExists() && userDoc().condominioId == cid;
    }

    match /users/{uid} {
      allow read:   if isSignedIn() && request.auth.uid == uid;
      allow read:   if isDRGTeam();
      allow create, update, delete: if isSuperAdmin();
    }

    match /condominios/{cid} {
      allow read:   if isDRGTeam();
      allow read:   if meuCondominio(cid);
      allow create, update, delete: if isDRGTeam();

      // Subcoleções: equipe escreve; síndico do condomínio lê.
      // (acesso do condômino à própria unidade entra na Fase 4)
      match /{sub}/{docId} {
        allow read, write: if isDRGTeam();
        allow read:        if isSindicoDe(cid);
      }
    }

    match /auditoria/{logId} {
      allow read:  if isDRGTeam();
      allow write: if false;
    }
  }
}
```

**Storage → Rules:**

```javascript
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function userDoc() {
      return firestore.get(/databases/(default)/documents/users/$(request.auth.uid)).data;
    }
    function isDRGTeam() {
      return request.auth != null
        && (userDoc().role == 'super_admin' || userDoc().role == 'operador_drg');
    }
    match /condominios/{cid}/{allPaths=**} {
      allow read, write: if isDRGTeam();
      allow read: if request.auth != null && userDoc().condominioId == cid;
    }
  }
}
```

---

## Bootstrap super-admin (uma vez, manualmente)

Não há signup público, então o primeiro usuário é criado à mão:

1. **Firebase Console → Authentication → Users → Add user** — crie com e-mail/senha.
2. Copie o **UID** gerado.
3. **Firestore → criar coleção `users` → documento com ID = UID**, campos:
   - `nome` (string), `email` (string)
   - `role` = `"super_admin"`
   - `ativo` = `true`
   - `criadoEm` = timestamp atual
4. Acesse a plataforma e faça login com esse e-mail/senha.

Os demais usuários (equipe, síndicos, condôminos) serão criados pelo módulo Usuários.

---

## Fases de entrega

- **Fase 1 — Fundação:** scaffold, auth, 3 perfis, navegação, cadastros (condomínios, unidades, condôminos, contratos), importação Excel/CSV. ← *em andamento*
- **Fase 2 — Faturamento:** competência mensal, emissão de boleto + Pix via Asaas, envio digital, régua de cobrança, conciliação.
- **Fase 3 — Financeiro:** antecipação/repasses, painel financeiro (DRE), carteira adquirida, calculadora de antecipação, simulador de proposta.
- **Fase 4 — Portais:** portal do síndico, portal do condômino (2ª via de boleto), cobrança judicial, auditoria/LGPD.

---

## Convenções

- Português em código, comentários e UI.
- Paleta slate (variáveis CSS em `:root`), raio 10px — igual ao DRG-Rently.
- Documentos, telefones e CEP salvos **só com dígitos**; máscara é visual.
- Cache-busting: query string `?v=AAAAMMDDx` nos assets (incrementar ao alterar).
- `app.js`: estado global em `State`; seções renderizadas em `#content` por `renderSection()`.
- Sem framework e sem build — os arquivos rodam como estão.
