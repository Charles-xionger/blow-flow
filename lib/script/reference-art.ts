export const realisticTexture = 'photorealistic, RAW photo, ultra-realistic photography, fine skin texture with visible pores, subtle skin imperfections, natural subsurface scattering, individual hair strands, natural skin tone, realistic eyes with catchlight';
export const realisticNegative = 'plastic skin, airbrushed, over-smoothed, beautified, CGI, 3D render, illustration, painting, cartoon, anime, distorted face, asymmetrical eyes, extra fingers, deformed hands, watermark, text, logo, lowres, blurry';
export type CharacterReferenceView = 'headshot' | 'turnaround';

export function characterReferencePrompt(name: string, description: string, view: CharacterReferenceView = 'turnaround'): string {
  const identity = `实拍要求：真实人物的未经美颜修饰的试镜照片，保留普通人的自然骨相、轻微左右差异、眼下纹理、自然唇纹与肤色变化；皮肤毛孔细小、不均匀，避免统一磨皮或刻意涂抹雀斑。真实头发有少量碎发，衣料有自然穿着褶皱。
角色：${name}\n人物描述：${description}\n根据以上设定呈现同一人物，依次落实年龄、性别、人种、身高体型；发型发色、脸型、五官、表情；上装、下装、鞋子、配饰。保留已有设定，不擅自添加饰物或改变服装。人物描述未说明的妆容采用 no makeup, bare skin。`;
  const composition = view === 'headshot'
    ? `Ultra-realistic photographic headshot of the person described above, slight natural smile or calm neutral expression, wearing the specified outfit and neckline, tight head-and-shoulders close-up, face large in frame, face centered, shoulders square to camera, direct eye contact with lens, clean light gray seamless backdrop.
shot on Canon EOS R5, 85mm lens, f/1.8, natural soft window light from the left, catchlight in eyes, shallow depth of field, 8K, high detail.`
    : `Unretouched live-action casting photographs of the same real person described above, arranged as a photographic triptych, showing three full-body views side by side: front view, side profile view, back view, standing straight, arms relaxed at sides, identical face, hairstyle and outfit in all three views.
plain light gray seamless studio background, large soft studio key light from camera left, gentle natural fill, visible three-dimensional facial modeling, subtle contact shadows beneath the shoes, full body visible from head to toe, consistent scale across all views, natural photographic perspective without wide-angle distortion, visible fabric texture and stitching, shot on Canon EOS R5, 85mm lens, 8K, high detail. Keep all three views sharp and equally readable.`;
  return `${identity}\n\n${composition}\n${realisticTexture}\n\nNegative: ${realisticNegative}${view === 'turnaround' ? ', inconsistent outfit between views, different face between views, cropped feet, cropped head, extra limbs' : ''}`;
}
