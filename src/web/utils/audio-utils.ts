export const normalizeAudioSampleRate = (rate: number): number => {
    if (!rate) return 0;

    // Common sample rates
    const commonRates = [8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000, 176400, 192000];

    // Find closest common rate
    return commonRates.reduce((prev, curr) =>
        Math.abs(curr - rate) < Math.abs(prev - rate) ? curr : prev
    );
};