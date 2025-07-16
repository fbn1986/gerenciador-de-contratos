const functions = require("firebase-functions");
const admin = require("firebase-admin");
const sgMail = require("@sendgrid/mail");
const cors = require("cors")({origin: true});

admin.initializeApp();

// Configura a chave de API do SendGrid
if (functions.config().sendgrid && functions.config().sendgrid.key) {
  sgMail.setApiKey(functions.config().sendgrid.key);
} else {
  console.warn("Chave de API do SendGrid não configurada. As notificações por e-mail não funcionarão.");
}

// --- FUNÇÃO AUXILIAR DE AUTENTICAÇÃO ---
// Esta função verifica o token do usuário e seu papel de admin
const verifyAdmin = async (req, res) => {
    if (!req.headers.authorization || !req.headers.authorization.startsWith('Bearer ')) {
        console.error('Nenhum token de ID do Firebase foi passado como um token Bearer no cabeçalho de autorização.');
        res.status(403).send('Não autorizado');
        return null;
    }

    const idToken = req.headers.authorization.split('Bearer ')[1];
    try {
        const decodedIdToken = await admin.auth().verifyIdToken(idToken);
        const callerUid = decodedIdToken.uid;
        const callerRoleDoc = await admin.firestore().collection("userRoles").doc(callerUid).get();

        if (!callerRoleDoc.exists() || callerRoleDoc.data().role !== "admin") {
            res.status(403).send({ error: { message: "Apenas administradores podem executar esta ação." } });
            return null;
        }
        return decodedIdToken; // Retorna o token decodificado se for admin
    } catch (error) {
        console.error('Erro ao verificar o token de ID do Firebase:', error);
        res.status(403).send('Não autorizado');
        return null;
    }
};


// --- GESTÃO DE USUÁRIOS E PERMISSÕES ---

exports.assignInitialRole = functions.auth.user().onCreate(async (user) => {
    const { uid, email } = user;
    const rolesCollection = admin.firestore().collection("userRoles");
    try {
        const snapshot = await rolesCollection.get();
        const role = snapshot.empty ? "admin" : "Registra Proposta";
        await rolesCollection.doc(uid).set({
            role: role,
            email: email,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`Papel '${role}' atribuído para ${email}.`);
        if (role === 'admin') {
            await admin.firestore().collection('appConfig').doc('adminSetup').set({ done: true });
        }
    } catch (error) {
        console.error(`Falha ao atribuir papel para ${uid}:`, error);
    }
});

// ATUALIZADO: createUser agora é uma função onRequest
exports.createUser = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'POST') {
            return res.status(405).send('Método não permitido');
        }

        const decodedToken = await verifyAdmin(req, res);
        if (!decodedToken) return; // Se não for admin, a função verifyAdmin já enviou a resposta de erro.

        const { email, password, role } = req.body.data;
        if (!email || !password || !role) {
            return res.status(400).send({ error: { message: "Faltam parâmetros (email, password, role)." }});
        }

        try {
            const userRecord = await admin.auth().createUser({ email, password });
            await admin.firestore().collection("userRoles").doc(userRecord.uid).set({ role, email });
            return res.status(200).send({ data: { success: true, uid: userRecord.uid } });
        } catch (error) {
            console.error("Erro ao criar novo usuário:", error);
            if (error.code === 'auth/email-already-exists') {
                return res.status(409).send({ error: { message: 'O e-mail já está em uso.' }});
            }
            return res.status(500).send({ error: { message: 'Erro desconhecido ao criar usuário.', details: error.message }});
        }
    });
});


// --- NOTIFICAÇÕES POR E-MAIL ---
const notificationMap = {
    'Proposta Registrada': 'janainafaria@liesa.org.br',
    'Documentação Validada': 'camilla@liesa.org.br',
    'Pagamento Validado': 'vicepresidencia@liesa.org.br',
    'Pronta para Assinatura': 'alexandre@liesa.org.br',
    'Contrato Assinado e Concluído': 'janainafaria@liesa.org.br'
};
// ... (O resto das funções de notificação permanece igual, pois são gatilhos do Firestore)
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
        from: 'fernandoneto@liesa.org.br',
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
// ATUALIZADO: uploadFile e deleteFile agora são funções onRequest
const verifyAuthenticated = async (req, res) => {
    if (!req.headers.authorization || !req.headers.authorization.startsWith('Bearer ')) {
        res.status(403).send('Não autorizado');
        return null;
    }
    const idToken = req.headers.authorization.split('Bearer ')[1];
    try {
        return await admin.auth().verifyIdToken(idToken);
    } catch (error) {
        res.status(403).send('Não autorizado');
        return null;
    }
};

exports.uploadFile = functions.region('southamerica-east1').https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'POST') return res.status(405).send('Método não permitido');
        
        const decodedToken = await verifyAuthenticated(req, res);
        if (!decodedToken) return;

        const { fileContent, fileName, contractId } = req.body.data;
        if (!fileContent || !fileName || !contractId) {
            return res.status(400).send({ error: { message: "Dados insuficientes." }});
        }
        try {
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
            return res.status(200).send({ data: { success: true, newAttachment: { id: newAttachmentRef.id, ...attachmentData } } });
        } catch (error) {
            console.error("ERRO NO UPLOAD:", error);
            return res.status(500).send({ error: { message: "Erro no servidor ao processar o upload.", details: error.message }});
        }
    });
});

exports.deleteFile = functions.region('southamerica-east1').https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'POST') return res.status(405).send('Método não permitido');

        const decodedToken = await verifyAuthenticated(req, res);
        if (!decodedToken) return;

        const { contractId, attachmentId, storagePath } = req.body.data;
        if (!contractId || !attachmentId || !storagePath) {
            return res.status(400).send({ error: { message: "Dados insuficientes." }});
        }
        try {
            await admin.firestore().collection('sharedContracts').doc(contractId).collection('anexos').doc(attachmentId).delete();
            await admin.storage().bucket().file(storagePath).delete();
            return res.status(200).send({ data: { success: true } });
        } catch (error) {
            console.error("ERRO AO DELETAR ANEXO:", error);
            return res.status(500).send({ error: { message: "Erro no servidor ao deletar o anexo.", details: error.message }});
        }
    });
});
