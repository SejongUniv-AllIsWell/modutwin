# Modutwin

**Modutwin** | A web platform that creates digital twins of building interiors using 3D Gaussian Splatting.  
* [Website](https://splat.wiki)
* [Demo Video](https://youtu.be/1Raxe9ffwnc)
* [Paper](https://github.com/user-attachments/files/29479934/KCGS2026.pdf) KCGS2026


| Before(Only Corridor) | After(With Rooms) |
|:---:|:---:|
| <img width="360" height="225" alt="복도_정합전" src="https://github.com/user-attachments/assets/e8fc9b88-215e-4698-a335-9e409adb0720" /> | <img width="360" height="225" alt="복도_정합후_9초" src="https://github.com/user-attachments/assets/d17fd1bd-6442-4efa-bb0a-f1a8060a37d7" /> |

## Core Features
Modular Indoor Digital Twins via Door-Based Alignment of 3DGS Assets
- [3DGS asset Refinement](#3DGS-asset-Refinement)
- [Automatic Door Corner Extraction](#Automatic-Door-Corner-Extraction)
- [Automatic Door-Based Alignment](#Automatic-Door-Based-Alignment)
- [Door Interaction (Open & Close)](#Door-Interaction (Open & Close))

<br>  

---

### 3DGS asset Refinement
* Without Refining Indoor 3DGS Assets...
→ Assets OVERLAP!
  | Example | 
  |:---:|
  | <img width="360" height="167" alt="다듬기안한모듈충돌" src="https://github.com/user-attachments/assets/0241528e-8862-481e-83a4-bb05850614b1" /> |
* With Refining
  | Original | After Outer Gaussian Removal | After Boundary Mesh Generation |
  |:---:|:---:|:---:|
  | <img width="1800" height="1008" alt="out_1_cropped" src="https://github.com/user-attachments/assets/caecf60c-edca-4168-b708-e3848e995015" /> | <img width="1800" height="1008" alt="out_2_cropped" src="https://github.com/user-attachments/assets/04ecf586-ba53-481f-87f3-b21918a400e6" /> | <img width="1800" height="1008" alt="out_3_cropped" src="https://github.com/user-attachments/assets/27e81a56-eabc-402e-be83-281bba887ca0" /> |
  | <img width="1800" height="1008" alt="in_1_cropped" src="https://github.com/user-attachments/assets/c06818b1-f902-4f05-9613-eb37953aa701" /> | <img width="1800" height="1008" alt="in_2_cropped" src="https://github.com/user-attachments/assets/fefeb85a-2f05-47f8-b68f-6fd251a4f2f8" /> | <img width="1800" height="1008" alt="in_3_cropped" src="https://github.com/user-attachments/assets/86dd32df-4302-4f4d-9eb5-98ab9e9aca9c" /> |

* After Connecting
  | Screenshot |
  |:---:|
  | <img width="380" height="250" alt="after_connect" src="https://github.com/user-attachments/assets/e4784e9a-f9c3-42de-9383-2fc43e55c989" /> |

* Appearance Preservation Evaluation Before/After Refinement

  | Asset | PSNR ↑ | SSIM ↑ | LPIPS ↓ |
  |:---:|:---:|:---:|:---:|
  | Asset 1 | 31.85 dB | 0.9759 | 0.0540 |
  | Asset 2 | 30.48 dB | 0.9705 | 0.0699 |
  | Asset 3 | 29.54 dB | 0.9693 | 0.0584 |
  | Asset 4 | 31.24 dB | 0.9476 | 0.0384 |
  | Average | 30.78 dB | 0.9658 | 0.0552 |

---

### Automatic Door Corner Extraction
using SAM3
  | Record |
  |:---:|
  | <img width="480" height="350" alt="sam3" src="https://github.com/user-attachments/assets/f8ea6be1-e007-4226-81c2-78fa3c6b1144" /> |

---

### Automatic Door-Based Alignment
| Record |
|:---:|
| <img width="581" height="350" alt="정합" src="https://github.com/user-attachments/assets/d9cef12e-0b4e-4fda-8e02-9e3c122aa7c4" /> |

---

### Door Interaction (Open & Close)
| Record |
|:---:|
| <img width="800" height="391" alt="door_openclose" src="https://github.com/user-attachments/assets/c13dd2ea-b897-4627-86af-62644e3925d2" /> |

---

### Future Work: Automatic Room Boundary Surface Extraction using PointCloud of Gaussians
- using a PointNet++-based network

| Ceiling & Floor | Walls |
|:---:|:---:|
| <img width="150" height="150" alt="image" src="https://github.com/user-attachments/assets/6f459332-8532-4fc7-8f9a-bd4e6cdaf91a" /> | <img width="150" height="150" alt="image" src="https://github.com/user-attachments/assets/c86a9be7-db51-4542-ada6-3ec6f11fb26d" /> |
