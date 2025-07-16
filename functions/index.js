const functions = require("firebase-functions");
const admin = require("firebase-admin");
const sgMail = require("@sendgrid/mail");

admin.initializeApp();

// Configura a chave de API do SendGrid
sgMail.setApiKey(functions.config().sendgrid.key);

// --- GESTÃO DE USUÁRIOS E PERMISSÕES ---

exports.assignInitialRole = functions.auth.user().onCreate(async (user) => {
    const { uid, email } = user;
    const rolesCollection = admin.firestore().collection("userRoles");

    try {
        const snapshot = await rolesCollection.limit(1).get();
        const role = snapshot.empty ? "admin" : "user";

        await rolesCollection.doc(uid).set({
            role: role,
            email: email,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`Papel '${role}' atribuído para ${email}.`);
    } catch (error) {
        console.error(`Falha ao atribuir papel para ${uid}:`, error);
    }
});

exports.createUser = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "A requisição deve ser feita por um usuário autenticado.");
    }

    const callerUid = context.auth.uid;
    const callerRoleDoc = await admin.firestore().collection("userRoles").doc(callerUid).get();

    if (!callerRoleDoc.exists() || callerRoleDoc.data().role !== "admin") {
        throw new functions.https.HttpsError("permission-denied", "Apenas administradores podem criar novos usuários.");
    }

    const { email, password, role } = data;
    if (!email || !password || !role) {
        throw new functions.https.HttpsError("invalid-argument", "Faltam parâmetros (email, password, role).");
    }

    try {
        const userRecord = await admin.auth().createUser({ email, password });
        await admin.firestore().collection("userRoles").doc(userRecord.uid).set({ role, email });
        return { success: true, uid: userRecord.uid };
    } catch (error) {
        if (error.code === 'auth/email-already-exists') {
            throw new functions.https.HttpsError('already-exists', 'O e-mail já está em uso.');
        }
        throw new functions.https.HttpsError('unknown', 'Erro desconhecido ao criar usuário.');
    }
});


// --- NOTIFICAÇÕES POR E-MAIL ---

const notificationMap = {
    'Minuta Registrada': 'janainafaria@liesa.org.br',
    'Minuta de Documentação Validada': 'camilla@liesa.org.br',
    'Minuta com Fluxo Aprovado': 'vicepresidencia@liesa.org.br',
    'Minuta em Processo de Assinatura': 'alexandre@liesa.org.br',
    'Minuta Assinada e Concluída': 'janainafaria@liesa.org.br'
};

async function sendNotificationEmail(contractData, previousStatus = "N/A") {
    const newStatus = contractData.status;
    const recipientEmail = notificationMap[newStatus];

    if (!recipientEmail) {
        console.log(`Nenhum destinatário encontrado para o status: ${newStatus}`);
        return;
    }

    const modifierEmail = contractData.lastModifiedBy ? contractData.lastModifiedBy.email : (contractData.createdBy ? contractData.createdBy.email : 'Sistema');
    
    const msg = {
        to: recipientEmail,
        from: 'fernandoneto@liesa.org.br', // IMPORTANTE: Use o seu e-mail verificado no SendGrid
        subject: `Atualização de Contrato: ${contractData.title} - ${newStatus}`,
        html: `<p>Olá,</p><p>O contrato <strong>${contractData.title}</strong> foi atualizado e precisa da sua atenção.</p><ul><li><strong>Status Anterior:</strong> ${previousStatus}</li><li><strong>Novo Status:</strong> ${newStatus}</li><li><strong>Modificado por:</strong> ${modifierEmail}</li></ul><p>Por favor, acesse o sistema para revisar os detalhes.</p>`,
    };

    try {
        await sgMail.send(msg);
        console.log(`Email de notificação enviado para ${recipientEmail}`);
    } catch (error) {
        console.error('Erro ao enviar e-mail de notificação:', error);
    }
}

exports.notifyOnCreate = functions.firestore
    .document('sharedContracts/{contractId}')
    .onCreate((snap) => sendNotificationEmail(snap.data(), "Criado"));

exports.notifyOnUpdate = functions.firestore
    .document('sharedContracts/{contractId}')
    .onUpdate((change) => {
        if (change.before.data().status !== change.after.data().status) {
            sendNotificationEmail(change.after.data(), change.before.data().status);
        }
    });


// --- FUNÇÕES DE ARQUIVOS (UPLOAD E DELETE) ---

exports.uploadFile = functions.region('southamerica-east1').https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Usuário não autenticado.");
    }

    const { fileContent, fileName, contractId } = data;
    if (!fileContent || !fileName || !contractId) {
        throw new functions.https.HttpsError("invalid-argument", "Dados insuficientes (fileContent, fileName, contractId).");
    }

    try {
        const base64EncodedString = fileContent.replace(/^data:.*,/, '');
        const buffer = Buffer.from(base64EncodedString, 'base64');
        const bucket = admin.storage().bucket();
        const filePath = `contracts/${contractId}/${Date.now()}_${fileName}`;
        const file = bucket.file(filePath);

        await file.save(buffer, {
            metadata: { contentType: 'application/pdf' },
            public: true,
        });

        const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
        
        const attachmentData = {
            documentName: fileName,
            documentURL: publicUrl,
            storagePath: filePath,
            uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
            uploadedBy: { uid: context.auth.uid, email: context.auth.token.email }
        };

        // Salva o novo anexo no Firestore
        const newAttachmentRef = await admin.firestore()
            .collection('sharedContracts').doc(contractId)
            .collection('anexos').add(attachmentData);

        console.log(`Anexo salvo com sucesso no contrato ${contractId}`);

        // MUDANÇA PRINCIPAL: Retorna os dados do anexo que acabamos de criar
        return { 
            success: true, 
            newAttachment: { id: newAttachmentRef.id, ...attachmentData } 
        };

    } catch (error) {
        console.error("ERRO DETALHADO NO UPLOAD:", error);
        throw new functions.https.HttpsError("internal", "Erro no servidor ao processar o upload.", error.message);
    }
});
/**
 * Função para deletar um anexo (arquivo no Storage e referência no Firestore).
 * Esta é a função que estava faltando.
 */
exports.deleteFile = functions.region('southamerica-east1').https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Usuário não autenticado.");
    }

    const { contractId, attachmentId, storagePath } = data;
    if (!contractId || !attachmentId || !storagePath) {
        throw new functions.https.HttpsError("invalid-argument", "Dados insuficientes (contractId, attachmentId, storagePath).");
    }

    try {
        // Deleta a referência no Firestore
        await admin.firestore()
            .collection('sharedContracts').doc(contractId)
            .collection('anexos').doc(attachmentId).delete();

        // Deleta o arquivo no Storage
        await admin.storage().bucket().file(storagePath).delete();

        console.log(`Anexo ${attachmentId} deletado com sucesso.`);
        return { success: true };

    } catch (error) {
        console.error("ERRO AO DELETAR ANEXO:", error);
        throw new functions.https.HttpsError("internal", "Erro no servidor ao deletar o anexo.", error.message);
    }
});