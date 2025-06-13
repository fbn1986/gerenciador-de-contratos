const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();

/**
 * Função v1 acionada na criação de um usuário para definir o primeiro como admin.
 */
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

/**
 * Função Chamável (Callable Function) v1 para criar novos usuários.
 */
exports.createUser = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated", "A requisição deve ser feita por um usuário autenticado."
    );
  }

  const callerUid = context.auth.uid;
  const callerRoleDoc = await admin.firestore().collection("userRoles").doc(callerUid).get();

  if (!callerRoleDoc.exists() || callerRoleDoc.data().role !== "admin") {
      throw new functions.https.HttpsError(
        "permission-denied", "Apenas administradores podem criar novos usuários."
      );
  }

  const { email, password, role } = data;
  if (!email || !password || !role) {
    throw new functions.https.HttpsError(
      "invalid-argument", "Faltam parâmetros (email, password, role)."
    );
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
