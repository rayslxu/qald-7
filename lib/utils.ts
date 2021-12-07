export function snakeCase(v : string) {
    return v.replace(/[() _-]+/g, '_').toLowerCase();
}

export function waitFinish(stream : NodeJS.WritableStream) : Promise<void> {
    return new Promise((resolve, reject) => {
        stream.once('finish', resolve);
        stream.on('error', reject);
    });
}