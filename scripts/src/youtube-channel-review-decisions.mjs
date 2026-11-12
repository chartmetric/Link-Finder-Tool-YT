// Explicit user reviews, not model judgments or globally rejected channels.
// Match the entire catalog artist/channel pair; never reject a channel for
// another artist or infer that an artist has no other YouTube presence.
export const youtubeChannelReviews = [
  ['3551673','14789664','UC_avONjSEW5_1YukNN9ljbg','Artist has no own channel; uploader is not artist-owned'],
  ['3551673','14789664','UCKo7pV29OIMzVOs2LoRkN-g','Artist has no own channel; uploader is not artist-owned'],
  ['3869046','11776202','UCOgASZVYeB6U37pL_8Y1Ofw','ZJSTV uploader is not the artist channel'],
  ['3869046','11776202','UCp8cPvx_Od76EL66vvCnhRA','ZJSTV uploader is not the artist channel'],
  ['3933297','16306244','UC6vWjDzkj0JryCDHKimIKfQ','User-rejected false positive'],
  ['3933297','16306244','UC1yhNRN9qrTmpvCFwfHZ2FA','User-rejected false positive'],
].map(([profileId,cmArtist,channelId,reason])=>Object.freeze({
  profileId,cmArtist,url:'https://www.youtube.com/channel/'+channelId,
  status:'rejected',source:'user_review',reason,
}));
