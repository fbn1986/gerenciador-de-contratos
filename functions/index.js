const functions = require("firebase-functions");
const admin = require("firebase-admin");
const sgMail = require("@sendgrid/mail");
const cors = require("cors");

// Inicializa o handler de CORS para permitir pedidos do seu site
const corsHandler = cors({ origin: "https://relcontratos.netlify.app" });

admin.initializeApp();
const db = admin.firestore();

// Configura a chave de API do SendGrid
if (functions.config().sendgrid && functions.config().sendgrid.key) {
  sgMail.setApiKey(functions.config().sendgrid.key);
} else {
  console.warn("Chave de API do SendGrid não configurada. As notificações por e-mail estarão desativadas.");
}

// --- FUNÇÃO AUXILIAR DE PERMISSÃO ---
/**
 * Verifica se a função do usuário é de Admin ou Presidente.
 * @param {string | null} role A função do usuário.
 * @returns {boolean} True se for um usuário privilegiado.
 */
function isPrivilegedUser(role) {
    return role === 'admin' || role === 'Presidente';
}


// --- GESTÃO DE USUÁRIOS E PERMISSÕES ---

exports.assignInitialRole = functions.auth.user().onCreate(async (user) => {
    const { uid, email } = user;
    const rolesCollection = db.collection("userRoles");
    try {
        const snapshot = await rolesCollection.get();
        const role = snapshot.empty ? "admin" : "Registra Proposta";
        await rolesCollection.doc(uid).set({ role, email, createdAt: admin.firestore.FieldValue.serverTimestamp() });
        if (role === 'admin') {
            await db.collection('appConfig').doc('adminSetup').set({ done: true });
        }
        console.log(`Papel '${role}' atribuído para ${email}.`);
    } catch (error) {
        console.error(`Falha ao atribuir papel para ${uid}:`, error);
    }
});

exports.createUser = functions.region('southamerica-east1').https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
        try {
            if (!req.headers.authorization || !req.headers.authorization.startsWith('Bearer ')) {
                throw new functions.https.HttpsError('unauthenticated', 'Token não fornecido.');
            }
            const idToken = req.headers.authorization.split('Bearer ')[1];
            const decodedIdToken = await admin.auth().verifyIdToken(idToken);
            
            const callerRoleDoc = await db.collection("userRoles").doc(decodedIdToken.uid).get();
            const callerRole = callerRoleDoc.exists ? callerRoleDoc.data().role : null;

            // *** CORREÇÃO APLICADA AQUI ***
            // Agora verifica se o usuário é Admin OU Presidente.
            if (!isPrivilegedUser(callerRole)) {
                throw new functions.https.HttpsError('permission-denied', 'Apenas Admin ou Presidente podem executar esta ação.');
            }

            const { email, password, role } = req.body.data;
            if (!email || !password || !role) {
                throw new functions.https.HttpsError("invalid-argument", "Faltam parâmetros (email, password, role).");
            }
            
            const userRecord = await admin.auth().createUser({ email, password });
            await db.collection("userRoles").doc(userRecord.uid).set({ role, email });
            res.status(200).send({ data: { success: true, uid: userRecord.uid } });

        } catch (error) {
            console.error("Erro em createUser:", error);
            const status = error.code === 'unauthenticated' || error.code === 'permission-denied' ? 403 : 500;
            res.status(status).send({ error: { message: error.message || "Erro interno no servidor." } });
        }
    });
});


// --- NOTIFICAÇÕES ---
const notificationMap = {
    'Proposta Registrada': 'janainafaria@liesa.org.br',
    'Documentação Validada': 'camilla@liesa.org.br',
    'Pagamento Validado': 'vicepresidencia@liesa.org.br',
    'Pronta para Assinatura': 'alexandre@liesa.org.br',
    'Contrato Assinado e Concluído': 'janainafaria@liesa.org.br'
};

async function sendNotificationEmail(contractData, previousStatus = "N/A") {
    const newStatus = contractData.status;
    const recipientEmail = notificationMap[newStatus];
    if (!recipientEmail || !sgMail.apiKey) return;

    const modifierEmail = contractData.lastModifiedBy ? contractData.lastModifiedBy.email : (contractData.createdBy ? contractData.createdBy.email : 'Sistema');
    
    const msg = {
        to: recipientEmail,
        from: 'fernandoneto@liesa.org.br',
        subject: `Atualização de Contrato: ${contractData.title} - ${newStatus}`,
        html: `<p>Olá,</p><p>O contrato <strong>${contractData.title}</strong> foi atualizado.</p><ul><li>Status Anterior: ${previousStatus}</li><li>Novo Status: ${newStatus}</li><li>Modificado por: ${modifierEmail}</li></ul><p>Acesse o sistema para revisar.</p>`,
    };

    try {
        await sgMail.send(msg);
        console.log(`E-mail de notificação enviado para ${recipientEmail}`);
    } catch (error) {
        console.error('Erro ao enviar e-mail de notificação:', error.response ? error.response.body : error);
    }
}

exports.notifyOnCreate = functions.firestore.document('sharedContracts/{contractId}').onCreate((snap) => sendNotificationEmail(snap.data(), "Criado"));

exports.notifyOnUpdate = functions.firestore.document('sharedContracts/{contractId}').onUpdate((change) => {
    if (change.before.data().status !== change.after.data().status) {
        sendNotificationEmail(change.after.data(), change.before.data().status);
    }
});


// --- TRILHA DE AUDITORIA E DELEÇÃO ---

exports.auditOnCreate = functions.firestore
    .document('sharedContracts/{contractId}')
    .onCreate(async (snap, context) => {
        const contractData = snap.data();
        const { contractId } = context.params;
        const user = contractData.createdBy || { uid: 'unknown', email: 'Sistema' };

        const auditLog = {
            action: "Contrato Criado",
            details: `Contrato "${contractData.title}" criado com o status "${contractData.status}".`,
            user: { uid: user.uid, email: user.email },
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
        };

        return db.collection('sharedContracts').doc(contractId).collection('auditTrail').add(auditLog);
    });

exports.auditOnUpdate = functions.firestore
    .document('sharedContracts/{contractId}')
    .onUpdate(async (change, context) => {
        const before = change.before.data();
        const after = change.after.data();
        const { contractId } = context.params;
        const user = after.lastModifiedBy || { uid: 'unknown', email: 'Sistema' };

        const auditTrailRef = db.collection('sharedContracts').doc(contractId).collection('auditTrail');
        const logs = [];

        if (before.status !== after.status) {
            logs.push({
                action: "Status Alterado",
                details: `De "${before.status || 'N/A'}" para "${after.status || 'N/A'}"`,
            });
        }

        const fieldsToTrack = {
            title: "Título",
            contractedParty: "Parte Contratada",
            totalValue: "Valor Total",
            sector: "Setor",
            costCenter: "Centro de Custo"
        };

        for (const [field, label] of Object.entries(fieldsToTrack)) {
            if (before[field] !== after[field]) {
                logs.push({
                    action: `${label} Alterado`,
                    details: `De "${before[field] || 'N/A'}" para "${after[field] || 'N/A'}"`,
                });
            }
        }
        
        if (logs.length > 0) {
            const batch = db.batch();
            const timestamp = admin.firestore.FieldValue.serverTimestamp();

            logs.forEach(logData => {
                const logRef = auditTrailRef.doc();
                batch.set(logRef, { ...logData, user: { uid: user.uid, email: user.email }, timestamp });
            });
            await batch.commit();
        }
    });

exports.deleteContractAndLog = functions.region('southamerica-east1').https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
        try {
            if (!req.headers.authorization || !req.headers.authorization.startsWith('Bearer ')) {
                throw new functions.https.HttpsError('unauthenticated', 'Token não fornecido.');
            }
            const idToken = req.headers.authorization.split('Bearer ')[1];
            const decodedToken = await admin.auth().verifyIdToken(idToken);

            const callerRoleDoc = await db.collection("userRoles").doc(decodedToken.uid).get();
            const callerRole = callerRoleDoc.exists ? callerRoleDoc.data().role : null;
            
            // Usando a função auxiliar para consistência
            if (!isPrivilegedUser(callerRole)) {
                throw new functions.https.HttpsError('permission-denied', 'Apenas Admin ou Presidente podem apagar contratos.');
            }

            const { contractId } = req.body.data;
            if (!contractId) {
                throw new functions.https.HttpsError("invalid-argument", "ID do contrato não fornecido.");
            }

            const contractRef = db.doc(`sharedContracts/${contractId}`);
            const contractSnap = await contractRef.get();
            if (!contractSnap.exists) {
                throw new functions.https.HttpsError("not-found", "Contrato não encontrado.");
            }

            const contractData = contractSnap.data();
            const auditTrailSnaps = await contractRef.collection('auditTrail').get();
            const auditTrail = auditTrailSnaps.docs.map(doc => doc.data());
            const anexosSnaps = await contractRef.collection('anexos').get();
            const anexos = anexosSnaps.docs.map(doc => doc.data());

            const archiveRef = db.collection('archivedContracts').doc(contractId);
            await archiveRef.set({
                ...contractData,
                anexos,
                auditTrail: auditTrail,
                deletedBy: { uid: decodedToken.uid, email: decodedToken.email },
                deletedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            const bucket = admin.storage().bucket();
            for (const anexo of anexos) {
                if (anexo.storagePath) {
                    await bucket.file(anexo.storagePath).delete().catch(e => console.error(`Falha ao apagar arquivo ${anexo.storagePath}:`, e));
                }
            }

            const batch = db.batch();
            anexosSnaps.forEach(doc => batch.delete(doc.ref));
            auditTrailSnaps.forEach(doc => batch.delete(doc.ref));
            batch.delete(contractRef);
            await batch.commit();

            res.status(200).send({ data: { success: true, message: "Contrato apagado e arquivado com sucesso." } });

        } catch (error) {
            console.error("Erro em deleteContractAndLog:", error);
            const status = error.code === 'unauthenticated' || error.code === 'permission-denied' ? 403 : 500;
            res.status(status).send({ error: { message: error.message || "Erro interno no servidor." } });
        }
    });
});


// --- FUNÇÕES DE ARQUIVOS ---
exports.uploadFile = functions.region('southamerica-east1').https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
        try {
            if (!req.headers.authorization || !req.headers.authorization.startsWith('Bearer ')) {
                throw new functions.https.HttpsError('unauthenticated', 'Token não fornecido.');
            }
            const idToken = req.headers.authorization.split('Bearer ')[1];
            const decodedToken = await admin.auth().verifyIdToken(idToken);

            const { fileContent, fileName, contractId } = req.body.data;
            if (!fileContent || !fileName || !contractId) {
                throw new functions.https.HttpsError("invalid-argument", "Dados insuficientes para upload.");
            }
            const base64EncodedString = fileContent.replace(/^data:.*,/, '');
            const buffer = Buffer.from(base64EncodedString, 'base64');
            const bucket = admin.storage().bucket();
            const filePath = `contracts/${contractId}/${Date.now()}_${fileName}`;
            const file = bucket.file(filePath);
            await file.save(buffer, { metadata: { contentType: 'application/pdf' }, public: true });
            
            const publicUrl = file.publicUrl();

            const attachmentData = {
                documentName: fileName,
                documentURL: publicUrl,
                storagePath: filePath,
                uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
                uploadedBy: { uid: decodedToken.uid, email: decodedToken.email }
            };

            const contractRef = db.collection('sharedContracts').doc(contractId);
            const newAttachmentRef = await contractRef.collection('anexos').add(attachmentData);
            await contractRef.collection('auditTrail').add({
                action: "Anexo Adicionado",
                details: `Ficheiro "${fileName}" foi anexado.`,
                user: { uid: decodedToken.uid, email: decodedToken.email },
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
            });

            res.status(200).send({ data: { success: true, newAttachment: { id: newAttachmentRef.id, ...attachmentData } } });
        } catch (error) {
            console.error("Erro em uploadFile:", error);
            const status = error.code === 'unauthenticated' ? 403 : 500;
            res.status(status).send({ error: { message: error.message || "Erro interno no servidor." } });
        }
    });
});

exports.deleteFile = functions.region('southamerica-east1').https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
        try {
            if (!req.headers.authorization || !req.headers.authorization.startsWith('Bearer ')) {
                throw new functions.https.HttpsError('unauthenticated', 'Token não fornecido.');
            }
            const idToken = req.headers.authorization.split('Bearer ')[1];
            const decodedToken = await admin.auth().verifyIdToken(idToken);

            const { contractId, attachmentId, storagePath, fileName } = req.body.data;
            if (!contractId || !attachmentId || !storagePath) {
                throw new functions.https.HttpsError("invalid-argument", "Dados insuficientes para apagar ficheiro.");
            }

            await db.collection('sharedContracts').doc(contractId).collection('anexos').doc(attachmentId).delete();
            await admin.storage().bucket().file(storagePath).delete();

            await db.collection('sharedContracts').doc(contractId).collection('auditTrail').add({
                action: "Anexo Removido",
                details: `Ficheiro "${fileName || storagePath}" foi removido.`,
                user: { uid: decodedToken.uid, email: decodedToken.email },
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
            });

            res.status(200).send({ data: { success: true } });
        } catch (error) {
            console.error("Erro em deleteFile:", error);
            const status = error.code === 'unauthenticated' ? 403 : 500;
            res.status(status).send({ error: { message: error.message || "Erro interno no servidor." } });
        }
    });
});
