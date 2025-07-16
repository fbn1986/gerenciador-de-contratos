const functions = require("firebase-functions");
const admin = require("firebase-admin");
const sgMail = require("@sendgrid/mail");
const cors = require("cors");

// Inicializa o handler de CORS para permitir pedidos do seu site
const corsHandler = cors({ origin: "https://relcontratos.netlify.app" });

admin.initializeApp();

// Configura a chave de API do SendGrid
if (functions.config().sendgrid && functions.config().sendgrid.key) {
  sgMail.setApiKey(functions.config().sendgrid.key);
} else {
  console.warn("Chave de API do SendGrid não configurada.");
}

// --- GESTÃO DE USUÁRIOS E PERMISSÕES ---

exports.assignInitialRole = functions.auth.user().onCreate(async (user) => {
    const { uid, email } = user;
    const rolesCollection = admin.firestore().collection("userRoles");
    try {
        const snapshot = await rolesCollection.get();
        const role = snapshot.empty ? "admin" : "Registra Proposta";
        await rolesCollection.doc(uid).set({ role, email, createdAt: admin.firestore.FieldValue.serverTimestamp() });
        if (role === 'admin') {
            await admin.firestore().collection('appConfig').doc('adminSetup').set({ done: true });
        }
        console.log(`Papel '${role}' atribuído para ${email}.`);
    } catch (error) {
        console.error(`Falha ao atribuir papel para ${uid}:`, error);
    }
});

exports.createUser = functions.region('southamerica-east1').https.onRequest((req, res) => {
    // Usa o corsHandler para tratar o pedido
    corsHandler(req, res, async () => {
        try {
            if (!req.headers.authorization || !req.headers.authorization.startsWith('Bearer ')) {
                throw new functions.https.HttpsError('unauthenticated', 'Token não fornecido.');
            }
            const idToken = req.headers.authorization.split('Bearer ')[1];
            const decodedIdToken = await admin.auth().verifyIdToken(idToken);
            
            const callerRoleDoc = await admin.firestore().collection("userRoles").doc(decodedIdToken.uid).get();
            if (!callerRoleDoc.exists || callerRoleDoc.data().role !== "admin") {
                throw new functions.https.HttpsError('permission-denied', 'Apenas administradores podem executar esta ação.');
            }

            const { email, password, role } = req.body.data;
            if (!email || !password || !role) {
                throw new functions.https.HttpsError("invalid-argument", "Faltam parâmetros (email, password, role).");
            }
            
            const userRecord = await admin.auth().createUser({ email, password });
            await admin.firestore().collection("userRoles").doc(userRecord.uid).set({ role, email });
            res.status(200).send({ data: { success: true, uid: userRecord.uid } });

        } catch (error) {
            console.error("Erro em createUser:", error);
            const status = error.code === 'unauthenticated' || error.code === 'permission-denied' ? 403 : 500;
            res.status(status).send({ error: { message: error.message || "Erro interno no servidor." } });
        }
    });
});


// --- NOTIFICAÇÕES (Sem alterações) ---
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
    if (!recipientEmail) return;
    const modifierEmail = contractData.lastModifiedBy ? contractData.lastModifiedBy.email : (contractData.createdBy ? contractData.createdBy.email : 'Sistema');
    const msg = {
        to: recipientEmail,
        from: 'fernandoneto@liesa.org.br',
        subject: `Atualização de Contrato: ${contractData.title} - ${newStatus}`,
        html: `<p>Olá,</p><p>O contrato <strong>${contractData.title}</strong> foi atualizado.</p><ul><li>Status Anterior: ${previousStatus}</li><li>Novo Status: ${newStatus}</li><li>Modificado por: ${modifierEmail}</li></ul><p>Acesse o sistema para revisar.</p>`,
    };
    try {
        await sgMail.send(msg);
    } catch (error) {
        console.error('Erro ao enviar e-mail:', error);
    }
}
exports.notifyOnCreate = functions.firestore.document('sharedContracts/{contractId}').onCreate((snap) => sendNotificationEmail(snap.data(), "Criado"));
exports.notifyOnUpdate = functions.firestore.document('sharedContracts/{contractId}').onUpdate((change) => {
    if (change.before.data().status !== change.after.data().status) {
        sendNotificationEmail(change.after.data(), change.before.data().status);
    }
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
                throw new functions.https.HttpsError("invalid-argument", "Dados insuficientes.");
            }
            const base64EncodedString = fileContent.replace(/^data:.*,/, '');
            const buffer = Buffer.from(base64EncodedString, 'base64');
            const bucket = admin.storage().bucket();
            const filePath = `contracts/${contractId}/${Date.now()}_${fileName}`;
            const file = bucket.file(filePath);
            await file.save(buffer, { metadata: { contentType: 'application/pdf' }, public: true });
            const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
            const attachmentData = {
                documentName: fileName,
                documentURL: publicUrl,
                storagePath: filePath,
                uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
                uploadedBy: { uid: decodedToken.uid, email: decodedToken.email }
            };
            const newAttachmentRef = await admin.firestore().collection('sharedContracts').doc(contractId).collection('anexos').add(attachmentData);
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
            await admin.auth().verifyIdToken(req.headers.authorization.split('Bearer ')[1]);

            const { contractId, attachmentId, storagePath } = req.body.data;
            if (!contractId || !attachmentId || !storagePath) {
                throw new functions.https.HttpsError("invalid-argument", "Dados insuficientes.");
            }
            await admin.firestore().collection('sharedContracts').doc(contractId).collection('anexos').doc(attachmentId).delete();
            await admin.storage().bucket().file(storagePath).delete();
            res.status(200).send({ data: { success: true } });
        } catch (error) {
            console.error("Erro em deleteFile:", error);
            const status = error.code === 'unauthenticated' ? 403 : 500;
            res.status(status).send({ error: { message: error.message || "Erro interno no servidor." } });
        }
    });
});
