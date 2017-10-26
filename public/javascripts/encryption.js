let globalEncryptionCallback = null;

function handleEncryption(requireEncryption, modal, callback) {
    if (requireEncryption && globalDataKey === null) {
        globalEncryptionCallback = callback;

        $("#encryption-password-dialog").dialog({
            modal: modal,
            width: 400,
            open: () => {
                if (!modal) {
                    // dialog steals focus for itself, which is not what we want for non-modal (viewing)
                    getNodeByKey(globalCurrentNote.detail.note_id).setFocus();
                }
            }
        });
    }
    else {
        callback();
    }
}

let globalDataKey = null;
let globalLastEncryptionOperationDate = null;

function getDataKey(password) {
    return computeScrypt(password, globalEncryptionSalt, (key, resolve, reject) => {
        const dataKeyAes = getDataKeyAes(key);

        const decryptedDataKey = decrypt(dataKeyAes, globalEncryptedDataKey);

        if (decryptedDataKey === false) {
            reject("Wrong password.");
        }

        resolve(decryptedDataKey);
    });
}

function computeScrypt(password, salt, callback) {
    const normalizedPassword = password.normalize('NFKC');
    const passwordBuffer = new buffer.SlowBuffer(normalizedPassword);
    const saltBuffer = new buffer.SlowBuffer(salt);

    // this settings take ~500ms on my laptop
    const N = 16384, r = 8, p = 1;
    // 32 byte key - AES 256
    const dkLen = 32;

    const startedDate = new Date();

    return new Promise((resolve, reject) => {
        scrypt(passwordBuffer, saltBuffer, N, r, p, dkLen, (error, progress, key) => {
            if (error) {
                console.log("Error: " + error);

                reject();
            }
            else if (key) {
                console.log("Computation took " + (new Date().getTime() - startedDate.getTime()) + "ms");

                callback(key, resolve, reject);
            }
            else {
                // update UI with progress complete
            }
        });
    });
}

$("#encryption-password-form").submit(() => {
    const password = $("#encryption-password").val();
    $("#encryption-password").val("");

    getDataKey(password).then(key => {
        $("#encryption-password-dialog").dialog("close");

        globalDataKey = key;

        for (const noteId of globalAllNoteIds) {
            const note = getNodeByKey(noteId);

            if (note.data.encryption > 0) {
                const title = decryptString(note.data.note_title);

                note.setTitle(title);
            }
        }

        if (globalEncryptionCallback !== null) {
            globalEncryptionCallback();

            globalEncryptionCallback = null;
        }
    })
        .catch(reason => {
            console.log(reason);

            alert(reason);
        });

    return false;
});

function resetEncryptionSession() {
    globalDataKey = null;

    if (globalCurrentNote.detail.encryption > 0) {
        loadNoteToEditor(globalCurrentNote.detail.note_id);

        for (const noteId of globalAllNoteIds) {
            const note = getNodeByKey(noteId);

            if (note.data.encryption > 0) {
                note.setTitle("[encrypted]");
            }
        }
    }
}

setInterval(() => {
    if (globalLastEncryptionOperationDate !== null && new Date().getTime() - globalLastEncryptionOperationDate.getTime() > globalEncryptionSessionTimeout * 1000) {
        resetEncryptionSession();
    }
}, 5000);

function isEncryptionAvailable() {
    return globalDataKey !== null;
}

function getDataAes() {
    globalLastEncryptionOperationDate = new Date();

    return new aesjs.ModeOfOperation.ctr(globalDataKey, new aesjs.Counter(5));
}

function getDataKeyAes(key) {
    return new aesjs.ModeOfOperation.ctr(key, new aesjs.Counter(5));
}

function encryptNoteIfNecessary(note) {
    if (note.detail.encryption === 0) {
        return note;
    }
    else {
        return encryptNote(note);
    }
}

function encryptString(str) {
    return encrypt(getDataAes(), str);
}

function encrypt(aes, str) {
    const payload = aesjs.utils.utf8.toBytes(str);
    const digest = sha256Array(payload).slice(0, 4);

    const digestWithPayload = concat(digest, payload);

    const encryptedBytes = aes.encrypt(digestWithPayload);

    return uint8ToBase64(encryptedBytes);
}

function decryptString(encryptedBase64) {
    const decryptedBytes = decrypt(getDataAes(), encryptedBase64);

    return aesjs.utils.utf8.fromBytes(decryptedBytes);
}

function decrypt(aes, encryptedBase64) {
    const encryptedBytes = base64ToUint8Array(encryptedBase64);

    const decryptedBytes = aes.decrypt(encryptedBytes);

    const digest = decryptedBytes.slice(0, 4);
    const payload = decryptedBytes.slice(4);

    const hashArray = sha256Array(payload);

    const computedDigest = hashArray.slice(0, 4);

    if (!arraysIdentical(digest, computedDigest)) {
        return false;
    }

    return payload;
}

function concat(a, b) {
    const result = [];

    for (let key in a) {
        result.push(a[key]);
    }

    for (let key in b) {
        result.push(b[key]);
    }

    return result;
}

function sha256Array(content) {
    const hash = sha256.create();
    hash.update(content);
    return hash.array();
}

function arraysIdentical(a, b) {
    let i = a.length;
    if (i !== b.length) return false;
    while (i--) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function encryptNote(note) {
    note.detail.note_title = encryptString(note.detail.note_title);
    note.detail.note_text = encryptString(note.detail.note_text);

    note.detail.encryption = 1;

    return note;
}

function encryptNoteAndSendToServer() {
    handleEncryption(true, true, () => {
        const note = globalCurrentNote;

        updateNoteFromInputs(note);

        encryptNote(note);

        saveNoteToServer(note);

        setNoteBackgroundIfEncrypted(note);
    });
}

function decryptNoteAndSendToServer() {
    handleEncryption(true, true, () => {
        const note = globalCurrentNote;

        updateNoteFromInputs(note);

        note.detail.encryption = 0;

        saveNoteToServer(note);

        setNoteBackgroundIfEncrypted(note);
    });
}

function decryptNoteIfNecessary(note) {
    if (note.detail.encryption > 0) {
        decryptNote(note);
    }
}

function decryptNote(note) {
    note.detail.note_title = decryptString(note.detail.note_title);
    note.detail.note_text = decryptString(note.detail.note_text);
}

function encryptSubTree(noteId) {
    handleEncryption(true, true, () => {
        updateSubTreeRecursively(noteId, note => {
            if (note.detail.encryption === null || note.detail.encryption === 0) {
                encryptNote(note);

                note.detail.encryption = 1;

                return true;
            }
            else {
                return false;
            }
        },
            note => {
                if (note.detail.note_id === globalCurrentNote.detail.note_id) {
                    loadNoteToEditor(note.detail.note_id);
                }
                else {
                    setTreeBasedOnEncryption(note);
                }
            });

        alert("Encryption finished.");
    });
}

function decryptSubTree(noteId) {
    handleEncryption(true, true, () => {
        updateSubTreeRecursively(noteId, note => {
            if (note.detail.encryption === 1) {
                decryptNote(note);

                note.detail.encryption = 0;

                return true;
            }
            else {
                return false;
            }
        },
            note => {
                if (note.detail.note_id === globalCurrentNote.detail.note_id) {
                    loadNoteToEditor(note.detail.note_id);
                }
                else {
                    setTreeBasedOnEncryption(note);
                }
            });

        alert("Decryption finished.");
    });
}

function updateSubTreeRecursively(noteId, updateCallback, successCallback) {
    updateNoteSynchronously(noteId, updateCallback, successCallback);

    const node = getNodeByKey(noteId);
    if (!node || !node.getChildren()) {
        return;
    }

    for (const child of node.getChildren()) {
        updateSubTreeRecursively(child.key, updateCallback, successCallback);
    }
}

function updateNoteSynchronously(noteId, updateCallback, successCallback) {
    $.ajax({
        url: baseApiUrl + 'notes/' + noteId,
        type: 'GET',
        async: false,
        success: note => {
            const needSave = updateCallback(note);

            if (!needSave) {
                return;
            }

            for (const link of note.links) {
                delete link.type;
            }

            $.ajax({
                url: baseApiUrl + 'notes/' + noteId,
                type: 'PUT',
                data: JSON.stringify(note),
                contentType: "application/json",
                async: false,
                success: () => {
                    if (successCallback) {
                        successCallback(note);
                    }
                },
                error: () => {
                    console.log("Updating " + noteId + " failed.");
                }
            });
        },
        error: () => {
            console.log("Reading " + noteId + " failed.");
        }
    });
}