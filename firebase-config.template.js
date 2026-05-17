// =============================================================
// DRG-Garantidora — Template de configuração Firebase
//
// Este arquivo NÃO contém credenciais. Para ativar a plataforma:
//
// 1. Crie um projeto em https://console.firebase.google.com
//    IMPORTANTE: projeto PRÓPRIO da DRG-Garantidora, separado do
//    DRG-Rently (isolamento de dados / LGPD).
// 2. Habilite: Authentication (provedor E-mail/Senha), Firestore
//    Database e Storage.
// 3. Configurações do projeto → Geral → Seus apps → adicionar app Web.
// 4. Copie o objeto firebaseConfig exibido pelo console.
// 5. Cole os valores em `firebase-config.js` (no lugar dos "PREENCHER").
//
// Obs.: as chaves do Firebase Web são públicas por design — a segurança
// é garantida pelas Security Rules do Firestore/Storage, não pela chave.
// =============================================================

const firebaseConfig = {
  apiKey: "PREENCHER",
  authDomain: "PREENCHER.firebaseapp.com",
  projectId: "PREENCHER",
  storageBucket: "PREENCHER.appspot.com",
  messagingSenderId: "PREENCHER",
  appId: "PREENCHER"
};

// Flag lida pelo app.js: indica se o Firebase já foi configurado.
window.FIREBASE_CONFIGURADO = firebaseConfig.apiKey !== "PREENCHER";

if (typeof firebase !== 'undefined' && !firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

window.db = firebase.firestore();
window.storage = firebase.storage();
window.auth = firebase.auth();
