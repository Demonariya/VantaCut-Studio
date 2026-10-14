const databaseName = 'vantacut-media-v1'
const storeName = 'assets'

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(storeName)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open the media cache.'))
  })
}

export async function storeMedia(id: string, file: Blob): Promise<void> {
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite')
    transaction.objectStore(storeName).put(file, id)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not save media to the local cache.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('Media cache write was cancelled.'))
  })
  database.close()
}

export async function loadMedia(id: string): Promise<Blob | undefined> {
  const database = await openDatabase()
  const file = await new Promise<Blob | undefined>((resolve, reject) => {
    const request = database.transaction(storeName, 'readonly').objectStore(storeName).get(id)
    request.onsuccess = () => resolve(request.result as Blob | undefined)
    request.onerror = () => reject(request.error ?? new Error('Could not read media from the local cache.'))
  })
  database.close()
  return file
}
