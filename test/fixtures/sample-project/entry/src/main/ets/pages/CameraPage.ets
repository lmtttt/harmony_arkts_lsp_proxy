@Entry
@Component
struct CameraPage {
  @State now: string = ''

  aboutToAppear(): void {
  }

  @Builder
  private Content() {
  }

  build() {
    Text(this.now)
  }
}

export class CameraViewModel {
}
