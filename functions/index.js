// Importa as ferramentas necessárias do Firebase Functions e do Firebase Admin SDK.
const functions = require("firebase-functions");
const admin = require("firebase-admin");

// Inicializa o Admin SDK para permitir que a função acesse outros serviços do Firebase.
admin.initializeApp();

/**
 * Função que é acionada automaticamente toda vez que um novo usuário é criado
 * no sistema de autenticação do Firebase.
 */
exports.assignInitialRole = functions.auth.user().onCreate(async (user) => {
  const { uid } = user;

  try {
    // Acessa a coleção 'userRoles' na raiz do Firestore. Este é um caminho simples e direto.
    const rolesCollection = admin.firestore().collection("userRoles");

    // Faz uma consulta para ver se já existe algum documento na coleção de papéis.
    // Limitamos a 1 para ser mais eficiente, pois só precisamos saber se está vazia ou não.
    const snapshot = await rolesCollection.limit(1).get();

    let role = "user"; // Por padrão, o papel é 'user'.

    // Se a coleção estiver vazia, este é o primeiro usuário a se registrar.
    if (snapshot.empty) {
      console.log(`Nenhum usuário encontrado. Designando ${uid} como admin.`);
      role = "admin"; // Promove a 'admin'.
    } else {
      console.log(`Usuários existentes encontrados. Designando ${uid} como user.`);
    }

    // Cria um documento na coleção 'userRoles' com o UID do novo usuário como ID.
    // O documento conterá o papel ('admin' or 'user') que acabamos de determinar.
    await rolesCollection.doc(uid).set({
      role: role,
      email: user.email,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`Papel '${role}' atribuído com sucesso para o usuário ${uid}.`);
    return null;

  } catch (error) {
    // Se ocorrer algum erro, ele será registrado nos logs do Firebase Functions.
    console.error(`Falha ao atribuir papel para o usuário ${uid}:`, error);
    return null;
  }
});
