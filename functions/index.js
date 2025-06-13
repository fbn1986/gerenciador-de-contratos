// Importa os novos gatilhos da v2 do Firebase Functions
const { onCall } = require("firebase-functions/v2/https");
const { onUserCreate } = require("firebase-functions/v2/auth");
const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();

/**
 * Função v2 acionada na criação de um usuário para definir o primeiro como admin.
 */
exports.assignInitialRole = onUserCreate(async (event) => {
  // O objeto 'event.data' contém informações sobre o usuário recém-criado.
  const user = event.data;
  const { uid, email } = user;

  // Acessa a coleção onde os papéis dos usuários são armazenados.
  const rolesCollection = admin.firestore().collection("userRoles");

  try {
    // Faz uma consulta para ver se já existe algum documento na coleção de papéis.
    const snapshot = await rolesCollection.limit(1).get();
    const role = snapshot.empty ? "admin" : "user";

    // Cria um documento na coleção 'userRoles' com o UID do novo usuário.
    await rolesCollection.doc(uid).set({
      role: role,
      email: email,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Usa o logger integrado para registrar o sucesso.
    functions.logger.log(`Papel '${role}' atribuído para ${email}.`);

  } catch (error) {
    functions.logger.error(`Falha ao atribuir papel para ${uid}:`, error);
  }
});


/**
 * Função Chamável (Callable Function) v2 para criar novos usuários.
 * Apenas usuários autenticados com o papel 'admin' podem chamar esta função.
 */
exports.createUser = onCall({ region: "us-central1" }, async (request) => {
  // 1. Verifica se quem está chamando é um admin autenticado.
  if (!request.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "A requisição deve ser feita por um usuário autenticado."
    );
  }
  
  const callerUid = request.auth.uid;
  const callerRoleDoc = await admin.firestore().collection("userRoles").doc(callerUid).get();
  
  if (!callerRoleDoc.exists() || callerRoleDoc.data().role !== "admin") {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Apenas administradores podem criar novos usuários."
      );
  }

  // 2. Valida os dados recebidos (email, senha, papel).
  const { email, password, role } = request.data;
  if (!email || !password || !role) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "A função deve ser chamada com 'email', 'password' e 'role'."
    );
  }

  // 3. Cria o novo usuário no sistema de autenticação.
  try {
    const userRecord = await admin.auth().createUser({
      email: email,
      password: password,
    });
    
    // 4. Define o papel do novo usuário no Firestore.
    await admin.firestore().collection("userRoles").doc(userRecord.uid).set({
      role: role,
      email: email,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { success: true, uid: userRecord.uid };

  } catch (error) {
    if (error.code === 'auth/email-already-exists') {
        throw new functions.https.HttpsError('already-exists', 'O endereço de e-mail já está em uso por outra conta.');
    }
    functions.logger.error("Erro ao criar usuário:", error);
    throw new functions.https.HttpsError('unknown', 'Ocorreu um erro desconhecido ao criar o usuário.');
  }
});
