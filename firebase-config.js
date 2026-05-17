// =============================================================
// DRG-Garantidora — Configuração Firebase
//
// >>> PREENCHA com os dados do SEU projeto Firebase. <<<
// Veja o passo a passo em firebase-config.template.js ou no README.md.
//
// Enquanto os valores estiverem como "PREENCHER", a plataforma exibe
// um aviso na tela de login e o acesso fica desabilitado.
// =============================================================

const firebaseConfig = {
  apiKey: "AIzaSyA-VS_W41MQryTqdlfHTVJyI_ZbsUwf3hw",
  authDomain: "drg-garantidora.firebaseapp.com",
  projectId: "drg-garantidora",
  storageBucket: "drg-garantidora.firebasestorage.app",
  messagingSenderId: "340257688189",
  appId: "1:340257688189:web:3b5162431023d42ffebf14"
};

// Flag lida pelo app.js: indica se o Firebase já foi configurado.
window.FIREBASE_CONFIGURADO = firebaseConfig.apiKey !== "PREENCHER";

if (typeof firebase !== 'undefined' && !firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

window.db = firebase.firestore();
window.storage = firebase.storage();
window.auth = firebase.auth();
